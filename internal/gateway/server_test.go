package gateway

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"gateway/internal/protocol"
)

type testHarness struct {
	srv  *Server
	http string
	tcp  string

	mu    sync.Mutex
	conns []net.Conn
}

func startTestServer(t *testing.T) *testHarness {
	t.Helper()
	srv := NewServer(Config{
		TCPAddr:     "127.0.0.1:0",
		HTTPAddr:    "127.0.0.1:0",
		IdleTimeout: 5 * time.Second,
	}, log.New(io.Discard, "", 0))
	if err := srv.Listen(); err != nil {
		t.Fatalf("listen: %v", err)
	}
	go srv.Serve()
	h := &testHarness{
		srv:  srv,
		http: "http://" + srv.HTTPAddr().String(),
		tcp:  srv.TCPAddr().String(),
	}
	t.Cleanup(func() {
		h.mu.Lock()
		conns := h.conns
		h.conns = nil
		h.mu.Unlock()
		for _, c := range conns {
			_ = c.Close()
		}
		// Let the server observe the disconnects and detach devices.
		time.Sleep(50 * time.Millisecond)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	return h
}

func dialDevice(t *testing.T, h *testHarness) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", h.tcp)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	h.mu.Lock()
	h.conns = append(h.conns, conn)
	h.mu.Unlock()
	return conn
}

func sendFrame(t *testing.T, conn net.Conn, f protocol.Frame) {
	t.Helper()
	if _, err := conn.Write(protocol.EncodeFrame(f)); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

func reportPayload(id string, temp int16, hum uint16, volt uint32, status uint32) []byte {
	return protocol.EncodeTLVs(
		protocol.TLV{Type: protocol.TLVDeviceID, Value: []byte(id)},
		protocol.TLV{Type: protocol.TLVTemp, Value: binary.BigEndian.AppendUint16(nil, uint16(temp))},
		protocol.TLV{Type: protocol.TLVHumidity, Value: binary.BigEndian.AppendUint16(nil, hum)},
		protocol.TLV{Type: protocol.TLVVoltage, Value: binary.BigEndian.AppendUint32(nil, volt)},
		protocol.TLV{Type: protocol.TLVStatus, Value: binary.BigEndian.AppendUint32(nil, status)},
	)
}

func waitForOnline(t *testing.T, h *testHarness, id string) {
	t.Helper()
	url := h.http + "/api/devices/" + id
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url)
		if err == nil {
			var st DeviceStatus
			_ = json.NewDecoder(resp.Body).Decode(&st)
			resp.Body.Close()
			if resp.StatusCode == 200 && st.Online {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("device %s did not come online", id)
}

func waitForReportSeq(t *testing.T, h *testHarness, id string, seq uint32) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(h.http + "/api/devices/" + id + "/reports/latest")
		if err == nil {
			var rep Report
			_ = json.NewDecoder(resp.Body).Decode(&rep)
			resp.Body.Close()
			if rep.Seq == seq {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("device %s never reported seq %d", id, seq)
}

func TestEndToEndReportAndOnlineList(t *testing.T) {
	h := startTestServer(t)

	conn := dialDevice(t, h)
	sendFrame(t, conn, protocol.Frame{
		Version: 1, Type: protocol.TypeReport, Seq: 100,
		Payload: reportPayload("dev-A", 255, 550, 3300, 7),
	})
	waitForOnline(t, h, "dev-A")

	resp, err := http.Get(h.http + "/api/devices/dev-A/reports/latest")
	if err != nil {
		t.Fatalf("http: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var rep Report
	if err := json.NewDecoder(resp.Body).Decode(&rep); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rep.Seq != 100 || rep.TempC == nil || *rep.TempC != 25.5 ||
		rep.Humidity == nil || *rep.Humidity != 55.0 ||
		rep.VoltageMV == nil || *rep.VoltageMV != 3300 ||
		rep.Status == nil || *rep.Status != 7 {
		t.Fatalf("unexpected report: %+v", rep)
	}

	resp2, err := http.Get(h.http + "/api/devices?online=1")
	if err != nil {
		t.Fatalf("http: %v", err)
	}
	defer resp2.Body.Close()
	var list struct {
		Devices []DeviceStatus `json:"devices"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	found := false
	for _, d := range list.Devices {
		if d.ID == "dev-A" && d.Online {
			found = true
		}
	}
	if !found {
		t.Fatalf("dev-A missing from online list: %+v", list.Devices)
	}
}

func TestCommandAckRoundTrip(t *testing.T) {
	h := startTestServer(t)
	conn := dialDevice(t, h)
	sendFrame(t, conn, protocol.Frame{
		Version: 1, Type: protocol.TypeHeartbeat, Seq: 1,
		Payload: protocol.EncodeTLV(protocol.TLVDeviceID, []byte("dev-C")),
	})
	waitForOnline(t, h, "dev-C")

	type frameResult struct {
		f   *protocol.Frame
		err error
	}
	got := make(chan frameResult, 1)
	go func() {
		dec := protocol.NewDecoder(conn, 1<<20)
		for {
			f, err := dec.Next()
			if err != nil {
				got <- frameResult{f, err}
				return
			}
			if f.Type == protocol.TypeCommand {
				got <- frameResult{f, nil}
				return
			}
		}
	}()

	type httpResult struct {
		resp *http.Response
		err  error
	}
	httpDone := make(chan httpResult, 1)
	go func() {
		r, e := http.Post(
			h.http+"/api/devices/dev-C/command",
			"application/json",
			strings.NewReader(`{"payloadHex":"04000101","timeoutMs":2000}`),
		)
		httpDone <- httpResult{r, e}
	}()

	var cmdSeq uint32
	select {
	case r := <-got:
		if r.err != nil {
			t.Fatalf("device read: %v", r.err)
		}
		cmdSeq = r.f.Seq
		ackPayload := protocol.EncodeTLV(protocol.TLVStatus, binary.BigEndian.AppendUint32(nil, 9))
		sendFrame(t, conn, protocol.Frame{Version: 1, Type: protocol.TypeAck, Seq: cmdSeq, Payload: ackPayload})
	case <-time.After(2 * time.Second):
		t.Fatal("gateway never sent command to device")
	}

	var resp *http.Response
	select {
	case hr := <-httpDone:
		var err error
		resp, err = hr.resp, hr.err
		if err != nil {
			t.Fatalf("http post: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("http command request never returned")
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("command status %d: %s", resp.StatusCode, body)
	}
	var out struct {
		AckSeq uint32 `json:"ackSeq"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.AckSeq != cmdSeq {
		t.Fatalf("ackSeq %d != command seq %d", out.AckSeq, cmdSeq)
	}
}

func TestCommandTimeoutReturns504(t *testing.T) {
	h := startTestServer(t)
	conn := dialDevice(t, h)
	sendFrame(t, conn, protocol.Frame{
		Version: 1, Type: protocol.TypeReport, Seq: 1,
		Payload: reportPayload("dev-S", 0, 0, 0, 0),
	})
	waitForOnline(t, h, "dev-S")

	start := time.Now()
	resp, err := http.Post(
		h.http+"/api/devices/dev-S/command",
		"application/json",
		strings.NewReader(`{"payloadHex":"","timeoutMs":300}`),
	)
	if err != nil {
		t.Fatalf("http: %v", err)
	}
	defer resp.Body.Close()
	elapsed := time.Since(start)

	if resp.StatusCode != http.StatusGatewayTimeout {
		t.Fatalf("want 504, got %d", resp.StatusCode)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("timeout took too long: %v", elapsed)
	}

	resp2, err := http.Get(h.http + "/api/devices/dev-S")
	if err != nil {
		t.Fatalf("http: %v", err)
	}
	defer resp2.Body.Close()
	var st DeviceStatus
	_ = json.NewDecoder(resp2.Body).Decode(&st)
	if !st.Online {
		t.Fatal("device should stay online after command timeout")
	}
}

func TestCommandUnknownAndOffline(t *testing.T) {
	h := startTestServer(t)

	resp, err := http.Post(h.http+"/api/devices/ghost/command", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("http: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown device want 404, got %d", resp.StatusCode)
	}

	conn := dialDevice(t, h)
	sendFrame(t, conn, protocol.Frame{
		Version: 1, Type: protocol.TypeHeartbeat, Seq: 1,
		Payload: protocol.EncodeTLV(protocol.TLVDeviceID, []byte("dev-D")),
	})
	waitForOnline(t, h, "dev-D")
	_ = conn.Close()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r, err := http.Post(h.http+"/api/devices/dev-D/command", "application/json", strings.NewReader(`{}`))
		if err == nil {
			code := r.StatusCode
			r.Body.Close()
			if code == http.StatusServiceUnavailable {
				return
			}
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatal("offline device never returned 503")
}

func TestBadDeviceDoesNotKillGatewayOrOthers(t *testing.T) {
	h := startTestServer(t)

	good := dialDevice(t, h)
	sendFrame(t, good, protocol.Frame{
		Version: 1, Type: protocol.TypeReport, Seq: 1,
		Payload: reportPayload("good-1", 200, 500, 3300, 0),
	})
	waitForOnline(t, h, "good-1")

	// Bogus length field: connection must be dropped, gateway survives.
	bad, err := net.Dial("tcp", h.tcp)
	if err != nil {
		t.Fatalf("dial bad: %v", err)
	}
	t.Cleanup(func() { _ = bad.Close() })
	_, _ = bad.Write([]byte{0xDE, 0xAD})
	huge := make([]byte, protocol.HeaderSize+4)
	huge[0], huge[1] = protocol.Magic0, protocol.Magic1
	binary.BigEndian.PutUint32(huge[9:13], 10<<20)
	_, _ = bad.Write(huge)

	// CRC-corrupted frame, then a valid frame on the same conn.
	bad2, err := net.Dial("tcp", h.tcp)
	if err != nil {
		t.Fatalf("dial bad2: %v", err)
	}
	t.Cleanup(func() { _ = bad2.Close() })
	corrupt := protocol.EncodeFrame(protocol.Frame{Version: 1, Type: protocol.TypeReport, Seq: 1,
		Payload: reportPayload("bad-2", 1, 1, 1, 1)})
	corrupt[len(corrupt)-1] ^= 0xFF
	_, _ = bad2.Write(corrupt)
	time.Sleep(100 * time.Millisecond)
	sendFrame(t, bad2, protocol.Frame{Version: 1, Type: protocol.TypeReport, Seq: 2,
		Payload: reportPayload("bad-2", 201, 501, 3301, 1)})

	sendFrame(t, good, protocol.Frame{Version: 1, Type: protocol.TypeReport, Seq: 2,
		Payload: reportPayload("good-1", 202, 502, 3302, 2)})

	waitForReportSeq(t, h, "good-1", 2)
	waitForReportSeq(t, h, "bad-2", 2)

	resp, err := http.Get(h.http + "/healthz")
	if err != nil {
		t.Fatalf("healthz: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz status %d", resp.StatusCode)
	}
}

func TestMalformedTLVReportDoesNotKillConnection(t *testing.T) {
	h := startTestServer(t)
	conn := dialDevice(t, h)

	var badPayload []byte
	badPayload = append(badPayload, protocol.EncodeTLV(protocol.TLVDeviceID, []byte("dev-x"))...)
	badPayload = append(badPayload, protocol.TLVTemp, 0x00, 0x09, 1, 2, 3) // claims 9, gives 3
	sendFrame(t, conn, protocol.Frame{Version: 1, Type: protocol.TypeReport, Seq: 1, Payload: badPayload})
	time.Sleep(150 * time.Millisecond)

	// Valid frame afterwards: bind may have happened on first frame even
	// though its TLVs were malformed; a good report must still land.
	sendFrame(t, conn, protocol.Frame{
		Version: 1, Type: protocol.TypeReport, Seq: 2,
		Payload: reportPayload("dev-x", 300, 600, 3300, 0),
	})
	waitForReportSeq(t, h, "dev-x", 2)

	resp, err := http.Get(h.http + "/api/devices/dev-x")
	if err != nil {
		t.Fatalf("http: %v", err)
	}
	defer resp.Body.Close()
	var st DeviceStatus
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !st.Online {
		t.Fatal("connection must stay online after a malformed-TLV report")
	}
}

func TestFallbackIDUsesRemoteAddr(t *testing.T) {
	h := startTestServer(t)
	conn := dialDevice(t, h)
	sendFrame(t, conn, protocol.Frame{
		Version: 1, Type: protocol.TypeReport, Seq: 1,
		Payload: protocol.EncodeTLV(protocol.TLVTemp, binary.BigEndian.AppendUint16(nil, 250)),
	})

	// Fallback ID is the server-side peer address. Some environments (NATed
	// loopback, e.g. WSL2 mirrored mode) remap the port, so assert on the
	// "tcp:" prefix and the report contents rather than a specific port.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(h.http + "/api/devices")
		if err != nil {
			t.Fatalf("http: %v", err)
		}
		var list struct {
			Devices []DeviceStatus `json:"devices"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&list)
		resp.Body.Close()
		for _, d := range list.Devices {
			if strings.HasPrefix(d.ID, "tcp:") && d.Online &&
				d.LastReport != nil && d.LastReport.TempC != nil &&
				*d.LastReport.TempC == 25.0 {
				return
			}
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatal("no online fallback device (tcp:*) with expected report")
}
