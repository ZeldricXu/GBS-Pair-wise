package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// HTTPServer 暴露网关的查询与控制接口。
type HTTPServer struct {
	gw         *Gateway
	cmdTimeout time.Duration
}

func NewHTTPServer(gw *Gateway, cmdTimeout time.Duration) *HTTPServer {
	return &HTTPServer{gw: gw, cmdTimeout: cmdTimeout}
}

func (s *HTTPServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/devices", s.handleListDevices)
	mux.HandleFunc("GET /api/devices/{id}/latest", s.handleLatest)
	mux.HandleFunc("POST /api/devices/{id}/command", s.handleCommand)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	return mux
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// GET /api/devices —— 当前在线设备列表。
func (s *HTTPServer) handleListDevices(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"devices": s.gw.ListDevices(),
	})
}

// GET /api/devices/{id}/latest —— 某台设备最近一次上报。
func (s *HTTPServer) handleLatest(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	d, ok := s.gw.GetDevice(id)
	if !ok {
		writeErr(w, http.StatusNotFound, "device offline or unknown")
		return
	}
	rep := d.LatestReport()
	if rep == nil {
		writeErr(w, http.StatusNotFound, "no report received yet")
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

type commandRequest struct {
	// PayloadHex 是下行指令的 TLV 载荷（hex 编码）。
	PayloadHex string `json:"payload_hex"`
	// TimeoutMs 可选，覆盖默认应答超时。
	TimeoutMs int `json:"timeout_ms,omitempty"`
}

// POST /api/devices/{id}/command —— 下发 0x81 指令并等待 0x03 应答。
// 设备不应答时按超时返回 504，不会一直挂住。
func (s *HTTPServer) handleCommand(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var req commandRequest
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "application/json") {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body: "+err.Error())
			return
		}
	} else {
		// 兼容直接 POST 裸 hex 字符串。
		buf := make([]byte, 1<<20)
		n, _ := r.Body.Read(buf)
		req.PayloadHex = strings.TrimSpace(string(buf[:n]))
	}

	payload, err := hex.DecodeString(req.PayloadHex)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "payload_hex is not valid hex: "+err.Error())
		return
	}

	timeout := s.cmdTimeout
	if req.TimeoutMs > 0 {
		timeout = time.Duration(req.TimeoutMs) * time.Millisecond
	}

	ack, err := s.gw.SendCommand(id, payload, timeout)
	if err != nil {
		switch {
		case errors.Is(err, errDeviceOffline):
			writeErr(w, http.StatusNotFound, "device offline or unknown")
		case strings.Contains(err.Error(), "timeout"):
			writeErr(w, http.StatusGatewayTimeout, err.Error())
		default:
			writeErr(w, http.StatusBadGateway, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ack_seq":         ack.Seq,
		"ack_flags":       ack.Flags,
		"ack_payload_hex": hex.EncodeToString(ack.Payload),
	})
}
