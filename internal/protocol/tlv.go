package protocol

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
)

// Payload TLV types. Types 1-4 are defined by the vendor spec; TypeDeviceID
// is an optional extension the simulator/gateway agree on so a device can
// carry a stable name. Unknown types are preserved as raw TLVs.
const (
	TLVTemp     = 0x01 // signed, 0.1 degree Celsius
	TLVHumidity = 0x02 // unsigned, 0.1 percent RH
	TLVVoltage  = 0x03 // unsigned, millivolts
	TLVStatus   = 0x04 // unsigned integer status code
	TLVDeviceID = 0x05 // UTF-8 device identifier (extension)
)

var errTruncatedTLV = errors.New("protocol: truncated TLV")

// TLV is one type-length-value element.
type TLV struct {
	Type  byte
	Value []byte
}

// MarshalJSON renders a TLV as {"type":n,"valueHex":"..."} instead of
// base64-encoding the value, which is friendlier for monitoring scripts.
func (t TLV) MarshalJSON() ([]byte, error) {
	return []byte(fmt.Sprintf(`{"type":%d,"valueHex":%q}`, t.Type, hex.EncodeToString(t.Value))), nil
}

// EncodeTLV serializes a single TLV.
func EncodeTLV(t byte, value []byte) []byte {
	buf := make([]byte, 3+len(value))
	buf[0] = t
	binary.BigEndian.PutUint16(buf[1:3], uint16(len(value)))
	copy(buf[3:], value)
	return buf
}

// EncodeTLVs serializes several TLVs into one frame payload.
func EncodeTLVs(tlvs ...TLV) []byte {
	n := 0
	for _, t := range tlvs {
		n += 3 + len(t.Value)
	}
	buf := make([]byte, 0, n)
	for _, t := range tlvs {
		buf = append(buf, EncodeTLV(t.Type, t.Value)...)
	}
	return buf
}

// ParseTLVs decodes TLVs in a payload. A malformed element (truncated header
// or length overrunning the payload) makes the remainder unlocatable, so
// decoding stops there: valid elements before it are returned together with
// an error.
func ParseTLVs(payload []byte) ([]TLV, error) {
	var out []TLV
	for len(payload) > 0 {
		if len(payload) < 3 {
			return out, fmt.Errorf("%w: %d trailing byte(s)", errTruncatedTLV, len(payload))
		}
		t := payload[0]
		n := int(binary.BigEndian.Uint16(payload[1:3]))
		if n > len(payload)-3 {
			return out, fmt.Errorf("protocol: tlv type %d claims %d bytes, %d remain", t, n, len(payload)-3)
		}
		value := make([]byte, n)
		copy(value, payload[3:3+n])
		out = append(out, TLV{Type: t, Value: value})
		payload = payload[3+n:]
	}
	return out, nil
}

// FindTLV returns the first TLV of the given type, or nil.
func FindTLV(tlvs []TLV, typ byte) *TLV {
	for i := range tlvs {
		if tlvs[i].Type == typ {
			return &tlvs[i]
		}
	}
	return nil
}

// FindTLVBestEffort scans a raw payload for the first TLV of typ without
// requiring the whole payload to be well-formed. Malformed elements are
// skipped by advancing one byte, so it is used for fields that must survive
// a corrupt neighbouring TLV (such as device identity).
func FindTLVBestEffort(payload []byte, typ byte) *TLV {
	for len(payload) >= 3 {
		t := payload[0]
		n := int(binary.BigEndian.Uint16(payload[1:3]))
		if n > len(payload)-3 {
			payload = payload[1:]
			continue
		}
		if t == typ {
			v := make([]byte, n)
			copy(v, payload[3:3+n])
			return &TLV{Type: t, Value: v}
		}
		payload = payload[3+n:]
	}
	return nil
}

// Int16 decodes a big-endian signed 16-bit value.
func (t TLV) Int16() (int16, bool) {
	if len(t.Value) != 2 {
		return 0, false
	}
	return int16(binary.BigEndian.Uint16(t.Value)), true
}

// Uint16 decodes a big-endian unsigned 16-bit value.
func (t TLV) Uint16() (uint16, bool) {
	if len(t.Value) != 2 {
		return 0, false
	}
	return binary.BigEndian.Uint16(t.Value), true
}

// Uint32 decodes a big-endian unsigned 32-bit value.
func (t TLV) Uint32() (uint32, bool) {
	if len(t.Value) != 4 {
		return 0, false
	}
	return binary.BigEndian.Uint32(t.Value), true
}

// String decodes a UTF-8 value (no encoding conversion performed).
func (t TLV) String() string {
	return string(t.Value)
}
