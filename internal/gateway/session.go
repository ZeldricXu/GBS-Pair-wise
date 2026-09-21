package gateway

import (
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// session is one physical device TCP connection.
type session struct {
	conn      net.Conn
	closed    atomic.Bool
	writeMu   sync.Mutex
	connected time.Time

	// Protocol version observed on the first frame (0 until then).
	ver atomic.Uint32

	// Counters surfaced when the connection drops.
	framesOK  atomic.Uint64
	framesBad atomic.Uint64
	skipped   atomic.Uint64
	oversized atomic.Bool
}

func newSession(conn net.Conn, now time.Time) *session {
	return &session{conn: conn, connected: now}
}

func (s *session) write(b []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.conn.Write(b)
	return err
}

func (s *session) close() error {
	if !s.closed.CompareAndSwap(false, true) {
		return nil
	}
	return s.conn.Close()
}

func (s *session) remoteAddr() string {
	return s.conn.RemoteAddr().String()
}

func (s *session) connectedAt() time.Time {
	return s.connected
}

func (s *session) version() byte {
	return byte(s.ver.Load())
}

func (s *session) setVersion(v byte) {
	s.ver.Store(uint32(v))
}
