package main

import (
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// Report 记录一次上报。
type Report struct {
	At         time.Time     `json:"at"`
	Seq        uint32        `json:"seq"`
	PayloadHex string        `json:"payload_hex"`
	Decoded    DecodedReport `json:"decoded"`
}

// Device 表示一台已连接的设备。协议本身不带设备号，
// 因此用对端 IP 作为设备标识（车间内每台采集设备一个固定 IP）。
type Device struct {
	ID          string    `json:"id"`
	RemoteAddr  string    `json:"remote_addr"`
	ConnectedAt time.Time `json:"connected_at"`
	LastSeenAt  time.Time `json:"last_seen_at"`
	LastSeq     uint32    `json:"last_seq"`

	conn   net.Conn
	writeMu sync.Mutex

	mu     sync.RWMutex
	latest *Report

	pendingMu sync.Mutex
	pending   map[uint32]chan *Frame
}

// DeviceInfo 是设备在线状态的快照（不含最近上报，避免列表接口过重）。
type DeviceInfo struct {
	ID          string    `json:"id"`
	RemoteAddr  string    `json:"remote_addr"`
	ConnectedAt time.Time `json:"connected_at"`
	LastSeenAt  time.Time `json:"last_seen_at"`
	LastSeq     uint32    `json:"last_seq"`
}

// LatestReport 返回最近一次上报的拷贝。
func (d *Device) LatestReport() *Report {
	d.mu.RLock()
	defer d.mu.RUnlock()
	if d.latest == nil {
		return nil
	}
	r := *d.latest
	return &r
}

// Gateway 维护所有设备连接，并处理指令下发/应答匹配。
type Gateway struct {
	mu      sync.RWMutex
	devices map[string]*Device

	seqCounter atomic.Uint32

	readIdleTimeout time.Duration
}

func NewGateway(readIdleTimeout time.Duration) *Gateway {
	return &Gateway{
		devices:         make(map[string]*Device),
		readIdleTimeout: readIdleTimeout,
	}
}

// ListDevices 返回当前在线设备快照。
func (g *Gateway) ListDevices() []DeviceInfo {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]DeviceInfo, 0, len(g.devices))
	for _, d := range g.devices {
		out = append(out, DeviceInfo{
			ID:          d.ID,
			RemoteAddr:  d.RemoteAddr,
			ConnectedAt: d.ConnectedAt,
			LastSeenAt:  d.LastSeenAt,
			LastSeq:     d.LastSeq,
		})
	}
	return out
}

// GetDevice 按 ID 取在线设备。
func (g *Gateway) GetDevice(id string) (*Device, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	d, ok := g.devices[id]
	return d, ok
}

// Serve 在 ln 上接受设备连接，每个连接一个 goroutine，天然隔离：
// 单台设备发疯只会占用自己的 goroutine，不会影响其它设备。
func (g *Gateway) Serve(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("accept error: %v", err)
			continue
		}
		go g.handleConn(conn)
	}
}

func deviceIDFromConn(conn net.Conn) string {
	host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err != nil {
		return conn.RemoteAddr().String()
	}
	return host
}

func (g *Gateway) handleConn(conn net.Conn) {
	id := deviceIDFromConn(conn)
	now := time.Now()
	d := &Device{
		ID:          id,
		RemoteAddr:  conn.RemoteAddr().String(),
		ConnectedAt: now,
		LastSeenAt:  now,
		conn:        conn,
		pending:     make(map[uint32]chan *Frame),
	}

	g.mu.Lock()
	if old, ok := g.devices[id]; ok {
		// 同 IP 重连：踢掉旧连接，避免两份状态。
		old.conn.Close()
	}
	g.devices[id] = d
	g.mu.Unlock()
	log.Printf("device %s connected from %s", id, d.RemoteAddr)

	defer func() {
		conn.Close()
		g.mu.Lock()
		// 只有自己还在表里时才摘除，防止误删重连后的新连接。
		if cur, ok := g.devices[id]; ok && cur == d {
			delete(g.devices, id)
		}
		g.mu.Unlock()
		// 唤醒所有等待应答的调用方。
		d.pendingMu.Lock()
		for seq, ch := range d.pending {
			close(ch)
			delete(d.pending, seq)
		}
		d.pendingMu.Unlock()
		log.Printf("device %s disconnected", id)
	}()

	fr := NewFrameReader(conn)
	for {
		conn.SetReadDeadline(time.Now().Add(g.readIdleTimeout))
		f, err := fr.ReadFrame()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				log.Printf("device %s idle timeout", id)
			} else if err != io.EOF && !errors.Is(err, net.ErrClosed) {
				log.Printf("device %s read error: %v", id, err)
			}
			return
		}
		d.LastSeenAt = time.Now()
		d.LastSeq = f.Seq
		switch f.Type {
		case FrameTypeReport:
			d.mu.Lock()
			d.latest = &Report{
				At:         time.Now(),
				Seq:        f.Seq,
				PayloadHex: hex.EncodeToString(f.Payload),
				Decoded:    DecodeReport(f.Payload),
			}
			d.mu.Unlock()
		case FrameTypeHeartbeat:
			// 心跳只用于刷新 LastSeenAt，上面已处理。
		case FrameTypeAck:
			d.pendingMu.Lock()
			ch, ok := d.pending[f.Seq]
			if ok {
				delete(d.pending, f.Seq)
			}
			d.pendingMu.Unlock()
			if ok {
				ch <- f
			} else {
				log.Printf("device %s ack with unknown seq %d, dropped", id, f.Seq)
			}
		default:
			log.Printf("device %s unknown frame type 0x%02x, dropped", id, f.Type)
		}
	}
}

var errDeviceOffline = errors.New("device offline")

// SendCommand 给设备下发一帧 0x81 指令，并等待相同序号的 0x03 应答。
// 超时或连接断开都会返回错误，调用方据此向 HTTP 客户端报错。
func (g *Gateway) SendCommand(id string, payload []byte, timeout time.Duration) (*Frame, error) {
	d, ok := g.GetDevice(id)
	if !ok {
		return nil, errDeviceOffline
	}

	seq := g.seqCounter.Add(1)
	ch := make(chan *Frame, 1)
	d.pendingMu.Lock()
	d.pending[seq] = ch
	d.pendingMu.Unlock()
	defer func() {
		d.pendingMu.Lock()
		delete(d.pending, seq)
		d.pendingMu.Unlock()
	}()

	pkt := EncodeFrame(FrameTypeCommand, 0, seq, payload)
	d.writeMu.Lock()
	d.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err := d.conn.Write(pkt)
	d.writeMu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("write command: %w", err)
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case f, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("connection closed while waiting for ack")
		}
		return f, nil
	case <-timer.C:
		return nil, fmt.Errorf("command timeout after %s", timeout)
	}
}
