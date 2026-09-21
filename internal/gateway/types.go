package gateway

import (
	"errors"
	"time"

	"gateway/internal/protocol"
)

// Sentinel errors returned by the registry / devices.
var (
	ErrDeviceOffline = errors.New("device is offline")
	ErrDeviceUnknown = errors.New("device is unknown")
)

// Report is the decoded view of a device's most recent report frame.
// Nil pointer fields mean the TLV was absent from the frame.
type Report struct {
	Seq       uint32         `json:"seq"`
	Version   byte           `json:"version"`
	Flags     byte           `json:"flags"`
	Time      time.Time      `json:"time"`
	TempC     *float64       `json:"tempC,omitempty"`     // TLV 0x01, degrees Celsius
	Humidity  *float64       `json:"humidity,omitempty"`  // TLV 0x02, percent RH
	VoltageMV *uint32        `json:"voltageMv,omitempty"` // TLV 0x03, millivolts
	Status    *uint64        `json:"status,omitempty"`    // TLV 0x04, raw status code
	DeviceID  string         `json:"deviceId,omitempty"`  // TLV 0x05 if present
	Raw       []protocol.TLV `json:"raw,omitempty"`
}

// DeviceStatus is the external view of one device.
type DeviceStatus struct {
	ID          string    `json:"id"`
	Online      bool      `json:"online"`
	RemoteAddr  string    `json:"remoteAddr,omitempty"`
	ConnectedAt time.Time `json:"connectedAt,omitempty"`
	LastSeen    time.Time `json:"lastSeen"`
	LastReport  *Report   `json:"lastReport,omitempty"`
}

// CommandResult is what a downlink command resolves to.
type CommandResult struct {
	AckSeq  uint32
	Payload []protocol.TLV
}

// buildReport turns a decoded frame payload into a Report.
// It returns the report and any TLV parse error; when the TLV stream is
// malformed the report is nil.
func buildReport(f *protocol.Frame, now time.Time) (*Report, error) {
	tlvs, err := protocol.ParseTLVs(f.Payload)
	if err != nil {
		return nil, err
	}
	r := &Report{
		Seq:     f.Seq,
		Version: f.Version,
		Flags:   f.Flags,
		Time:    now,
		Raw:     tlvs,
	}
	for i := range tlvs {
		t := &tlvs[i]
		switch t.Type {
		case protocol.TLVTemp:
			if v, ok := t.Int16(); ok {
				c := float64(v) / 10.0
				r.TempC = &c
			}
		case protocol.TLVHumidity:
			if v, ok := t.Uint16(); ok {
				h := float64(v) / 10.0
				r.Humidity = &h
			}
		case protocol.TLVVoltage:
			switch {
			case len(t.Value) == 4:
				if v, ok := t.Uint32(); ok {
					r.VoltageMV = &v
				}
			case len(t.Value) == 2:
				if v, ok := t.Uint16(); ok {
					u := uint32(v)
					r.VoltageMV = &u
				}
			}
		case protocol.TLVStatus:
			if v, ok := decodeUint(t.Value); ok {
				r.Status = &v
			}
		case protocol.TLVDeviceID:
			r.DeviceID = t.String()
		}
	}
	return r, nil
}

// decodeUint handles 1/2/4/8 byte unsigned big-endian status values.
func decodeUint(b []byte) (uint64, bool) {
	if len(b) == 0 || len(b) > 8 {
		return 0, false
	}
	var v uint64
	for _, c := range b {
		v = v<<8 | uint64(c)
	}
	return v, true
}

// deviceIDFromTLV extracts the optional device-name TLV.
func deviceIDFromTLV(f *protocol.Frame) string {
	if t := protocol.FindTLVBestEffort(f.Payload, protocol.TLVDeviceID); t != nil {
		return t.String()
	}
	return ""
}
