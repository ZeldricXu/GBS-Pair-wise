package gateway

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"gateway/internal/protocol"
)

// Config holds gateway tunables.
type Config struct {
	TCPAddr      string
	HTTPAddr     string
	MaxPayload   int           // reject frames advertising a larger payload
	IdleTimeout  time.Duration // no bytes/frames -> close (read deadline basis)
	ReadDeadline time.Duration // deadline used while waiting for the next frame
}

// Server runs the device TCP listener and the HTTP API.
type Server struct {
	cfg Config
	log *log.Logger
	reg *Registry

	tcpLn   net.Listener
	httpSrv *http.Server
	httpLn  net.Listener

	wg      sync.WaitGroup // active connection goroutines
	connsMu sync.Mutex
	conns   map[*session]struct{}

	closeOnce sync.Once
	closed    chan struct{}
}

// NewServer constructs a server without starting it.
func NewServer(cfg Config, logger *log.Logger) *Server {
	if logger == nil {
		logger = log.Default()
	}
	if cfg.MaxPayload <= 0 {
		cfg.MaxPayload = 1 << 20
	}
	if cfg.IdleTimeout <= 0 {
		cfg.IdleTimeout = 2 * time.Minute
	}
	if cfg.ReadDeadline <= 0 {
		cfg.ReadDeadline = cfg.IdleTimeout
	}
	s := &Server{
		cfg:    cfg,
		log:    logger,
		reg:    NewRegistry(),
		conns:  make(map[*session]struct{}),
		closed: make(chan struct{}),
	}
	mux := http.NewServeMux()
	registerRoutes(mux, s)
	s.httpSrv = &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	return s
}

// Registry exposes the device store (used by tests).
func (s *Server) Registry() *Registry { return s.reg }

// TCPAddr / HTTPAddr report the effective listener addresses.
func (s *Server) TCPAddr() net.Addr  { return s.tcpLn.Addr() }
func (s *Server) HTTPAddr() net.Addr { return s.httpLn.Addr() }

// Listen binds both sockets. Use addr ":0" to bind an ephemeral port in tests.
func (s *Server) Listen() error {
	tcpLn, err := net.Listen("tcp", s.cfg.TCPAddr)
	if err != nil {
		return fmt.Errorf("listen device port: %w", err)
	}
	s.tcpLn = tcpLn

	httpLn, err := net.Listen("tcp", s.cfg.HTTPAddr)
	if err != nil {
		_ = tcpLn.Close()
		return fmt.Errorf("listen http port: %w", err)
	}
	s.httpSrv.Addr = httpLn.Addr().String()
	s.httpLn = httpLn
	return nil
}

// Serve accepts connections and runs until the listener is closed.
func (s *Server) Serve() {
	go func() {
		if err := s.httpSrv.Serve(s.httpLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.log.Printf("http server error: %v", err)
		}
	}()

	s.wg.Add(1)
	defer s.wg.Done()

	for {
		conn, err := s.tcpLn.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			s.log.Printf("accept error: %v", err)
			continue
		}
		go s.handleConn(conn)
	}
}

// Shutdown stops listeners and waits for connection goroutines to drain.
func (s *Server) Shutdown(ctx context.Context) error {
	s.closeOnce.Do(func() { close(s.closed) })

	_ = s.tcpLn.Close()

	s.connsMu.Lock()
	for sess := range s.conns {
		_ = sess.close()
	}
	s.connsMu.Unlock()

	shutdownErr := s.httpSrv.Shutdown(ctx)

	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
	return shutdownErr
}

func (s *Server) trackConn(sess *session, add bool) {
	s.connsMu.Lock()
	if add {
		s.conns[sess] = struct{}{}
	} else {
		delete(s.conns, sess)
	}
	s.connsMu.Unlock()
}

// handleConn owns one device connection for its entire lifetime. Any failure
// here only tears down this conn: other devices are untouched.
func (s *Server) handleConn(conn net.Conn) {
	remote := conn.RemoteAddr().String()
	// TCP keepalive detects half-open connections (power loss, NAT drops).
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetKeepAlive(true)
		_ = tc.SetKeepAlivePeriod(30 * time.Second)
	}

	sess := newSession(conn, s.now())
	s.trackConn(sess, true)
	var bound *Device // nil until the first frame names/binds the device
	defer func() {
		s.trackConn(sess, false)
		_ = conn.Close()
		s.wg.Done()
		if bound != nil {
			bound.detach(sess)
		}
		s.log.Printf("device conn closed %s ok=%d bad=%d skipped=%d oversized=%v",
			remote, sess.framesOK.Load(), sess.framesBad.Load(),
			sess.skipped.Load(), sess.oversized.Load())
	}()
	s.wg.Add(1)
	s.log.Printf("device connected %s", remote)

	dec := protocol.NewDecoder(conn, s.cfg.MaxPayload)

	for {
		// Reset on every loop: devices send frames every few hundred ms, so
		// a timeout here means the connection is dead or stuck.
		if err := conn.SetReadDeadline(s.now().Add(s.cfg.ReadDeadline)); err != nil {
			return
		}
		var f *protocol.Frame
		var err error
		f, err = dec.Next()
		sess.framesOK.Store(dec.FramesOK)
		sess.framesBad.Store(dec.FramesBad)
		sess.skipped.Store(dec.SkippedBytes)

		if err != nil {
			switch {
			case errors.Is(err, protocol.ErrPayloadTooLarge):
				sess.oversized.Store(true)
				s.log.Printf("oversized frame from %s, closing connection", remote)
				return
			case isTimeout(err):
				s.log.Printf("idle timeout for %s, closing", remote)
				return
			case errors.Is(err, protocol.ErrCRCMismatch):
				bad := sess.framesBad.Load()
				if bad == 1 || bad%100 == 0 {
					s.log.Printf("crc failure #%d from %s, resuming", bad, remote)
				}
				continue
			default:
				return // io error, EOF, connection-level break
			}
		}

		if f != nil {
			sess.setVersion(f.Version)
			if f.Version != 1 {
				s.log.Printf("unexpected protocol version %d from %s", f.Version, remote)
			}

			if bound == nil {
				id := deviceIDFromTLV(f)
				if id == "" {
					// The vendor frame does not carry a canonical device id;
					// fall back to the TCP peer address.
					id = "tcp:" + remote
				}
				bound = s.reg.Bind(id, sess)
				s.log.Printf("bound connection %s to device %s", remote, id)
			}
			bound.touch(s.now())
			s.routeFrame(bound, sess, f)
		}
	}
}

func (s *Server) routeFrame(d *Device, sess *session, f *protocol.Frame) {
	switch f.Type {
	case protocol.TypeReport:
		report, err := buildReport(f, s.now())
		if err != nil {
			s.log.Printf("device %s malformed TLV payload: %v", d.id, err)
			return
		}
		d.setReport(report)
	case protocol.TypeHeartbeat:
		// Activity is already recorded; nothing else to do.
	case protocol.TypeAck:
		if !d.resolveAck(f) {
			s.log.Printf("device %s sent ack for unknown seq %d", d.id, f.Seq)
		}
	default:
		s.log.Printf("device %s unknown frame type 0x%02x", d.id, f.Type)
	}
}

func (s *Server) now() time.Time { return time.Now() }

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}
