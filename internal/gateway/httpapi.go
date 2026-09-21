package gateway

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"gateway/internal/protocol"
)

const (
	maxCommandPayload = 4096
	defaultCmdTimeout = 3 * time.Second
	maxCmdTimeout     = 30 * time.Second
)

func registerRoutes(mux *http.ServeMux, s *Server) {
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"service": "device-gateway",
			"endpoints": []string{
				"GET /healthz",
				"GET /api/devices",
				"GET /api/devices/{id}",
				"GET /api/devices/{id}/reports/latest",
				"POST /api/devices/{id}/command",
			},
		})
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/devices", s.listDevices)
	mux.HandleFunc("GET /api/devices/{id}", s.getDevice)
	mux.HandleFunc("GET /api/devices/{id}/reports/latest", s.latestReport)
	mux.HandleFunc("POST /api/devices/{id}/command", s.sendCommand)
}

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	onlineOnly := r.URL.Query().Get("online") == "1" || strings.EqualFold(r.URL.Query().Get("online"), "true")
	devs := s.reg.List()
	out := make([]DeviceStatus, 0, len(devs))
	for _, d := range devs {
		st := d.status()
		if onlineOnly && !st.Online {
			continue
		}
		out = append(out, st)
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": out})
}

func (s *Server) getDevice(w http.ResponseWriter, r *http.Request) {
	d, ok := s.lookupDevice(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, d.status())
}

func (s *Server) latestReport(w http.ResponseWriter, r *http.Request) {
	d, ok := s.lookupDevice(w, r)
	if !ok {
		return
	}
	rep := d.report.Load()
	if rep == nil {
		writeError(w, http.StatusNotFound, "no report received yet")
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

type commandRequest struct {
	// Payload accepts either:
	//   - "payloadHex": raw frame payload as a hex string, or
	//   - "tlvs": [{type, valueBase64 | valueHex}] convenience encoding, or
	//   - "valueHex" shorthand for a single-TLV command (with "tlvType").
	PayloadHex string     `json:"payloadHex"`
	TLVs       []tlvInput `json:"tlvs"`
	TLVType    *int       `json:"tlvType"`
	ValueHex   string     `json:"valueHex"`
	TimeoutMS  int        `json:"timeoutMs"`
}

type tlvInput struct {
	Type        int    `json:"type"`
	ValueHex    string `json:"valueHex"`
	ValueBase64 string `json:"valueBase64"`
}

func (s *Server) sendCommand(w http.ResponseWriter, r *http.Request) {
	d, ok := s.lookupDevice(w, r)
	if !ok {
		return
	}

	var req commandRequest
	if r.ContentLength != 0 {
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
			return
		}
	}

	payload, err := buildCommandPayload(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	timeout := defaultCmdTimeout
	if req.TimeoutMS > 0 {
		timeout = time.Duration(req.TimeoutMS) * time.Millisecond
	}
	if timeout > maxCmdTimeout {
		timeout = maxCmdTimeout
	}

	res, err := d.sendCommand(payload, timeout)
	if err != nil {
		switch {
		case errors.Is(err, ErrDeviceOffline):
			writeError(w, http.StatusServiceUnavailable, err.Error())
		case errors.Is(err, ErrCommandTimeout):
			writeError(w, http.StatusGatewayTimeout, err.Error())
		default:
			writeError(w, http.StatusBadGateway, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"device":     d.id,
		"ackSeq":     res.AckSeq,
		"tlvs":       res.Payload,
		"payloadHex": hex.EncodeToString(appendTLVs(res.Payload)),
	})
}

func (s *Server) lookupDevice(w http.ResponseWriter, r *http.Request) (*Device, bool) {
	id := r.PathValue("id")
	d, err := s.reg.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error()+": "+id)
		return nil, false
	}
	return d, true
}

func buildCommandPayload(req commandRequest) ([]byte, error) {
	switch {
	case req.PayloadHex != "":
		p, err := hex.DecodeString(strings.TrimSpace(req.PayloadHex))
		if err != nil {
			return nil, errors.New("invalid payloadHex: " + err.Error())
		}
		if len(p) > maxCommandPayload {
			return nil, errors.New("payload too large")
		}
		return p, nil

	case len(req.TLVs) > 0:
		var tlvs []protocol.TLV
		for _, in := range req.TLVs {
			v, err := decodeTLVValue(in)
			if err != nil {
				return nil, err
			}
			if in.Type < 0 || in.Type > 255 {
				return nil, errors.New("tlv type out of range")
			}
			tlvs = append(tlvs, protocol.TLV{Type: byte(in.Type), Value: v})
		}
		p := protocol.EncodeTLVs(tlvs...)
		if len(p) > maxCommandPayload {
			return nil, errors.New("payload too large")
		}
		return p, nil

	case req.TLVType != nil:
		v, err := decodeHexMaybe(req.ValueHex)
		if err != nil {
			return nil, err
		}
		if *req.TLVType < 0 || *req.TLVType > 255 {
			return nil, errors.New("tlvType out of range")
		}
		return protocol.EncodeTLV(byte(*req.TLVType), v), nil
	}

	// Empty body is allowed: a zero-length-payload command.
	return nil, nil
}

func decodeTLVValue(in tlvInput) ([]byte, error) {
	switch {
	case in.ValueBase64 != "":
		v, err := base64.StdEncoding.DecodeString(in.ValueBase64)
		if err != nil {
			return nil, errors.New("invalid valueBase64: " + err.Error())
		}
		return v, nil
	case in.ValueHex != "":
		return decodeHexMaybe(in.ValueHex)
	default:
		return nil, nil
	}
}

func decodeHexMaybe(h string) ([]byte, error) {
	v, err := hex.DecodeString(strings.TrimSpace(h))
	if err != nil {
		return nil, errors.New("invalid hex: " + err.Error())
	}
	return v, nil
}

func appendTLVs(tlvs []protocol.TLV) []byte {
	return protocol.EncodeTLVs(tlvs...)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
