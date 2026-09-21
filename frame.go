package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
)

const (
	magicByte0 = 0xEB
	magicByte1 = 0x90

	headerLen   = 13 // magic(2) + version(1) + type(1) + flags(1) + seq(4) + payloadLen(4)
	crcLen      = 4
	maxPayload  = 1 << 20 // 1 MiB，超过视为畸形帧
	protoVer    = 0x01

	FrameTypeReport    = 0x01
	FrameTypeHeartbeat = 0x02
	FrameTypeAck       = 0x03
	FrameTypeCommand   = 0x81
)

var (
	errBadMagic   = errors.New("bad magic")
	errBadCRC     = errors.New("crc mismatch")
	errBadLength  = errors.New("payload length out of range")
	errBadVersion = errors.New("unsupported protocol version")
)

// Frame 是一帧解析后的结果。Payload 为原始字节，由上层按 TLV 解释。
type Frame struct {
	Version byte
	Type    byte
	Flags   byte
	Seq     uint32
	Payload []byte
}

// EncodeFrame 按协议组帧：魔数+版本+类型+标志+序号+长度+载荷+CRC32。
func EncodeFrame(frameType, flags byte, seq uint32, payload []byte) []byte {
	buf := make([]byte, 0, headerLen+len(payload)+crcLen)
	buf = append(buf, magicByte0, magicByte1, protoVer, frameType, flags)
	var tmp [8]byte
	binary.BigEndian.PutUint32(tmp[0:4], seq)
	buf = append(buf, tmp[0:4]...)
	binary.BigEndian.PutUint32(tmp[0:4], uint32(len(payload)))
	buf = append(buf, tmp[0:4]...)
	buf = append(buf, payload...)
	crc := crc32.ChecksumIEEE(buf)
	binary.BigEndian.PutUint32(tmp[0:4], crc)
	buf = append(buf, tmp[0:4]...)
	return buf
}

// FrameReader 从 TCP 流里切帧。TCP 是字节流，帧可能粘连也可能被切半，
// 这里用 io.ReadFull 精确读取；遇到坏魔数/畸形长度时逐字节扫描下一个魔数重同步，
// 保证单台设备的数据错乱只影响本连接，不会拖垮进程。
type FrameReader struct {
	r io.Reader
}

func NewFrameReader(r io.Reader) *FrameReader {
	return &FrameReader{r: r}
}

// resync 逐字节扫描直到找到魔数 0xEB 0x90，找到后返回（魔数已被消费）。
func (fr *FrameReader) resync() error {
	var b [1]byte
	prev := byte(0)
	for {
		if _, err := io.ReadFull(fr.r, b[:]); err != nil {
			return err
		}
		if prev == magicByte0 && b[0] == magicByte1 {
			return nil
		}
		prev = b[0]
	}
}

// ReadFrame 读取并校验一帧。返回的 error 为 nil 表示成功；
// 校验类错误（坏 CRC、版本不支持）会跳过该帧继续，调用方应重试；
// io 错误（EOF、超时）说明连接层出问题，调用方应关闭连接。
func (fr *FrameReader) ReadFrame() (*Frame, error) {
	for {
		f, err := fr.readOne()
		if err == nil {
			return f, nil
		}
		if errors.Is(err, errBadCRC) || errors.Is(err, errBadVersion) {
			// 长度可信但内容坏：丢弃本帧，继续读下一帧。
			continue
		}
		if errors.Is(err, errBadMagic) || errors.Is(err, errBadLength) {
			// 流已失步：扫描下一个魔数重同步。
			if rerr := fr.resync(); rerr != nil {
				return nil, rerr
			}
			// 魔数已消费，继续按帧头剩余部分读取。
			f, err = fr.readRestAfterMagic()
			if err == nil {
				return f, nil
			}
			if errors.Is(err, errBadCRC) || errors.Is(err, errBadVersion) ||
				errors.Is(err, errBadMagic) || errors.Is(err, errBadLength) {
				continue
			}
			return nil, err
		}
		return nil, err
	}
}

func (fr *FrameReader) readOne() (*Frame, error) {
	var magic [2]byte
	if _, err := io.ReadFull(fr.r, magic[:]); err != nil {
		return nil, err
	}
	if magic[0] != magicByte0 || magic[1] != magicByte1 {
		return nil, errBadMagic
	}
	return fr.readRestAfterMagic()
}

// readRestAfterMagic 在魔数已读出的前提下读取帧的剩余部分。
func (fr *FrameReader) readRestAfterMagic() (*Frame, error) {
	rest := make([]byte, headerLen-2)
	if _, err := io.ReadFull(fr.r, rest); err != nil {
		return nil, err
	}
	f := &Frame{
		Version: rest[0],
		Type:    rest[1],
		Flags:   rest[2],
		Seq:     binary.BigEndian.Uint32(rest[3:7]),
	}
	payloadLen := binary.BigEndian.Uint32(rest[7:11])
	if payloadLen > maxPayload {
		return nil, fmt.Errorf("%w: %d", errBadLength, payloadLen)
	}
	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(fr.r, payload); err != nil {
		return nil, err
	}
	var crcBuf [crcLen]byte
	if _, err := io.ReadFull(fr.r, crcBuf[:]); err != nil {
		return nil, err
	}
	// CRC 覆盖从魔数到载荷结束。
	crc := crc32.NewIEEE()
	crc.Write([]byte{magicByte0, magicByte1})
	crc.Write(rest)
	crc.Write(payload)
	if binary.BigEndian.Uint32(crcBuf[:]) != crc.Sum32() {
		return nil, errBadCRC
	}
	if f.Version != protoVer {
		return nil, errBadVersion
	}
	f.Payload = payload
	return f, nil
}
