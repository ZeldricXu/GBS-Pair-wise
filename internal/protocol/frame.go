// Package protocol implements the vendor binary frame and TLV encoding.
//
// Frame layout (all multi-byte integers big-endian):
//
//	magic(0xEB 0x90) | version(1) | type(1) | flags(1) |
//	seq(4) | payloadLen(4) | payload(payloadLen) | crc32(4)
//
// CRC32 (IEEE polynomial, same as zlib) covers every byte from the first
// magic byte through the end of the payload.
package protocol

import (
	"encoding/binary"
	"errors"
	"io"
)

const (
	Magic0 = 0xEB
	Magic1 = 0x90

	HeaderSize = 13 // magic(2)+version(1)+type(1)+flags(1)+seq(4)+len(4)
	CRCSize    = 4

	TypeReport    = 0x01 // device -> gateway, periodic report
	TypeHeartbeat = 0x02 // device -> gateway
	TypeAck       = 0x03 // device -> gateway, answer to a downlink command
	TypeCommand   = 0x81 // gateway -> device
)

var (
	// ErrPayloadTooLarge is returned when a frame on the wire advertises a
	// payload larger than the configured maximum. The caller must close the
	// connection because the stream cannot be skipped safely within limits.
	ErrPayloadTooLarge = errors.New("protocol: advertised payload exceeds max size")

	// ErrCRCMismatch is returned for a frame whose CRC check fails. The
	// stream stays synchronized (the frame length was consumed), so the
	// caller may continue reading.
	ErrCRCMismatch = errors.New("protocol: crc mismatch")
)

// Frame is one decoded protocol frame.
type Frame struct {
	Version byte
	Type    byte
	Flags   byte
	Seq     uint32
	Payload []byte
}

// EncodeFrame serializes a frame including the trailing CRC32.
func EncodeFrame(f Frame) []byte {
	buf := make([]byte, HeaderSize+len(f.Payload)+CRCSize)
	buf[0] = Magic0
	buf[1] = Magic1
	buf[2] = f.Version
	buf[3] = f.Type
	buf[4] = f.Flags
	binary.BigEndian.PutUint32(buf[5:9], f.Seq)
	binary.BigEndian.PutUint32(buf[9:13], uint32(len(f.Payload)))
	copy(buf[HeaderSize:], f.Payload)
	binary.BigEndian.PutUint32(buf[HeaderSize+len(f.Payload):], CRC(buf[:HeaderSize+len(f.Payload)]))
	return buf
}

// Decoder reads frames from a stream. It tolerates byte loss and garbage
// between frames by resynchronizing on the 0xEB 0x90 magic.
//
// A Decoder is not safe for concurrent use; a TCP connection has one reader.
type Decoder struct {
	r   io.Reader
	max int

	// Stats counters.
	FramesOK     uint64
	FramesBad    uint64 // CRC failures: frame was consumed, stream still aligned
	SkippedBytes uint64 // bytes discarded while hunting the magic
	Oversized    uint64
}

// NewDecoder creates a Decoder rejecting payloads larger than maxPayload
// (guard against bogus length fields exhausting memory).
func NewDecoder(r io.Reader, maxPayload int) *Decoder {
	return &Decoder{r: r, max: maxPayload}
}

// Next returns the next frame. It returns:
//   - a frame and nil on success,
//   - ErrCRCMismatch on a checksum failure (safe to call Next again),
//   - ErrPayloadTooLarge when the advertised length exceeds the limit,
//   - any io error (io.EOF included) when the underlying stream is dead.
func (d *Decoder) Next() (*Frame, error) {
	// Find the magic pair, one byte at a time, resynchronizing after
	// truncated packets or garbage bytes.
	have0 := false
	for {
		var b [1]byte
		if _, err := io.ReadFull(d.r, b[:]); err != nil {
			return nil, err
		}
		if !have0 {
			have0 = b[0] == Magic0
			if !have0 {
				d.SkippedBytes++
			}
			continue
		}
		if b[0] == Magic1 {
			break
		}
		d.SkippedBytes++
		have0 = b[0] == Magic0 // second chance for 0xEB 0xEB 0x90
	}

	var header [HeaderSize - 2]byte
	if _, err := io.ReadFull(d.r, header[:]); err != nil {
		return nil, err
	}

	length := binary.BigEndian.Uint32(header[7:11])
	if int(length) > d.max {
		d.Oversized++
		return nil, ErrPayloadTooLarge
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(d.r, payload); err != nil {
		return nil, err
	}

	var crcBuf [4]byte
	if _, err := io.ReadFull(d.r, crcBuf[:]); err != nil {
		return nil, err
	}

	// CRC covers magic + header + payload.
	covered := make([]byte, 0, HeaderSize+int(length))
	covered = append(covered, Magic0, Magic1)
	covered = append(covered, header[:]...)
	covered = append(covered, payload...)

	if CRC(covered) != binary.BigEndian.Uint32(crcBuf[:]) {
		d.FramesBad++
		return nil, ErrCRCMismatch
	}

	d.FramesOK++
	return &Frame{
		Version: header[0],
		Type:    header[1],
		Flags:   header[2],
		Seq:     binary.BigEndian.Uint32(header[3:7]),
		Payload: payload,
	}, nil
}
