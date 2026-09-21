package gateway

import (
	"sync"
	"sync/atomic"
	"time"

	"gateway/internal/protocol"
)

// Registry holds all devices (online or previously seen). Every device
// connection runs its own goroutines; the registry itself only serializes
// the small map/device bookkeeping, so one slow device cannot block others.
type Registry struct {
	mu      sync.RWMutex
	devices map[string]*Device
}

func NewRegistry() *Registry {
	return &Registry{devices: make(map[string]*Device)}
}

// Bind attaches a fresh connection to a device, replacing any older
// connection for that ID.
func (r *Registry) Bind(id string, sess *session) *Device {
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.devices[id]
	if !ok {
		d = &Device{
			id:  id,
			now: time.Now,
		}
		r.devices[id] = d
	}
	d.attach(sess)
	return d
}

// Get returns the device, or ErrDeviceUnknown.
func (r *Registry) Get(id string) (*Device, error) {
	r.mu.RLock()
	d, ok := r.devices[id]
	r.mu.RUnlock()
	if !ok {
		return nil, ErrDeviceUnknown
	}
	return d, nil
}

// List returns a snapshot of all known devices.
func (r *Registry) List() []*Device {
	r.mu.RLock()
	out := make([]*Device, 0, len(r.devices))
	for _, d := range r.devices {
		out = append(out, d)
	}
	r.mu.RUnlock()
	return out
}

// Device tracks one logical device and its current connection (if any).
type Device struct {
	id string

	mu       sync.Mutex
	sess     *session
	pending  map[uint32]chan ackOrErr
	nextSeq  atomic.Uint32
	lastSeen time.Time
	report   atomic.Pointer[Report]

	now func() time.Time
}

type ackOrErr struct {
	ack *protocol.Frame
	err error
}

func (d *Device) attach(sess *session) {
	d.mu.Lock()
	old := d.sess
	d.sess = sess
	d.failPendingLocked(errDeviceReconnected)
	now := d.now()
	d.lastSeen = now
	d.mu.Unlock()

	if old != nil {
		// Force the displaced connection down; ignore the error.
		_ = old.close()
	}
}

// detach removes the connection only if it is still current.
func (d *Device) detach(sess *session) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.sess != sess {
		return
	}
	d.sess = nil
	d.failPendingLocked(errDeviceGone)
}

func (d *Device) failPendingLocked(err error) {
	for seq, ch := range d.pending {
		select {
		case ch <- ackOrErr{err: err}:
		default:
		}
		delete(d.pending, seq)
	}
}

// touch records inbound activity.
func (d *Device) touch(t time.Time) {
	d.mu.Lock()
	d.lastSeen = t
	d.mu.Unlock()
}

func (d *Device) setReport(r *Report) {
	d.report.Store(r)
}

// resolveAck delivers an ack frame to the command waiting on its seq.
func (d *Device) resolveAck(f *protocol.Frame) bool {
	d.mu.Lock()
	ch := d.pending[f.Seq]
	if ch != nil {
		delete(d.pending, f.Seq)
	}
	d.mu.Unlock()
	if ch == nil {
		return false
	}
	ch <- ackOrErr{ack: f}
	return true
}

// IsOnline reports whether the device currently holds a connection.
func (d *Device) IsOnline() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.sess != nil
}

// status builds an external snapshot for the HTTP API.
func (d *Device) status() DeviceStatus {
	d.mu.Lock()
	sess := d.sess
	lastSeen := d.lastSeen
	d.mu.Unlock()

	s := DeviceStatus{
		ID:         d.id,
		Online:     sess != nil,
		LastSeen:   lastSeen,
		LastReport: d.report.Load(),
	}
	if sess != nil {
		s.RemoteAddr = sess.remoteAddr()
		s.ConnectedAt = sess.connectedAt()
	}
	return s
}

// sendCommand writes a command frame to the device and waits for the ack
// frame carrying the same seq, or returns after timeout / disconnect.
func (d *Device) sendCommand(payload []byte, timeout time.Duration) (*CommandResult, error) {
	d.mu.Lock()
	sess := d.sess
	if sess == nil {
		d.mu.Unlock()
		return nil, ErrDeviceOffline
	}
	seq := d.nextSeq.Add(1)
	ch := make(chan ackOrErr, 1)
	if d.pending == nil {
		d.pending = make(map[uint32]chan ackOrErr)
	}
	d.pending[seq] = ch
	d.mu.Unlock()

	defer func() {
		d.mu.Lock()
		if cur, ok := d.pending[seq]; ok && cur == ch {
			delete(d.pending, seq)
		}
		d.mu.Unlock()
	}()

	frame := protocol.EncodeFrame(protocol.Frame{
		Version: sess.version(),
		Type:    protocol.TypeCommand,
		Seq:     seq,
		Payload: payload,
	})
	if err := sess.write(frame); err != nil {
		return nil, err
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case r := <-ch:
		if r.err != nil {
			return nil, r.err
		}
		tlvs, _ := protocol.ParseTLVs(r.ack.Payload)
		return &CommandResult{AckSeq: r.ack.Seq, Payload: tlvs}, nil
	case <-timer.C:
		return nil, ErrCommandTimeout
	}
}
