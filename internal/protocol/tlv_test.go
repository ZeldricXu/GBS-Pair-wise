package protocol

import (
	"testing"
)

func TestTLVRoundTrip(t *testing.T) {
	payload := EncodeTLVs(
		TLV{Type: TLVTemp, Value: []byte{0xFE, 0x70}},     // -400 => -40.0C
		TLV{Type: TLVHumidity, Value: []byte{0x02, 0x58}}, // 600 => 60.0%
		TLV{Type: TLVDeviceID, Value: []byte("dev-1")},
	)
	tlvs, err := ParseTLVs(payload)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(tlvs) != 3 {
		t.Fatalf("want 3 TLVs, got %d", len(tlvs))
	}
	temp, ok := tlvs[0].Int16()
	if !ok || temp != -400 {
		t.Fatalf("temp = %d ok=%v", temp, ok)
	}
	hum, ok := tlvs[1].Uint16()
	if !ok || hum != 600 {
		t.Fatalf("humidity = %d ok=%v", hum, ok)
	}
	if got := FindTLV(tlvs, TLVDeviceID); got == nil || got.String() != "dev-1" {
		t.Fatalf("device id lookup failed: %+v", got)
	}
}

func TestParseTLVMalformed(t *testing.T) {
	// Header claims 10 bytes, only 2 present.
	_, err := ParseTLVs([]byte{0x01, 0x00, 0x0A, 0x00, 0x00})
	if err == nil {
		t.Fatal("expected error for overlong TLV")
	}
	// Truncated header.
	if _, err := ParseTLVs([]byte{0x01, 0x00}); err == nil {
		t.Fatal("expected error for truncated TLV header")
	}
}

func TestEncodeSingleTLV(t *testing.T) {
	raw := EncodeTLV(3, []byte{0x00, 0x01})
	if len(raw) != 5 || raw[0] != 3 || raw[1] != 0 || raw[2] != 2 ||
		raw[3] != 0 || raw[4] != 1 {
		t.Fatalf("bad TLV encoding: % x", raw)
	}
}
