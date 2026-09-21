package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	in := Frame{Version: 1, Type: TypeReport, Flags: 0xAB, Seq: 0xDEADBEEF, Payload: []byte{1, 0, 1, 42}}
	raw := EncodeFrame(in)

	if len(raw) != HeaderSize+len(in.Payload)+CRCSize {
		t.Fatalf("unexpected wire size %d", len(raw))
	}
	if raw[0] != Magic0 || raw[1] != Magic1 {
		t.Fatalf("bad magic: %x %x", raw[0], raw[1])
	}

	out, err := NewDecoder(bytes.NewReader(raw), 1024).Next()
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Version != 1 || out.Type != TypeReport || out.Flags != 0xAB ||
		out.Seq != 0xDEADBEEF || !bytes.Equal(out.Payload, in.Payload) {
		t.Fatalf("round trip mismatch: %+v", out)
	}
}

func TestStreamMultipleFrames(t *testing.T) {
	f1 := EncodeFrame(Frame{Version: 1, Type: TypeHeartbeat, Seq: 1})
	f2 := EncodeFrame(Frame{Version: 1, Type: TypeReport, Seq: 2, Payload: []byte("hello")})
	dec := NewDecoder(bytes.NewReader(append(f1, f2...)), 1024)

	got, err := dec.Next()
	if err != nil || got.Seq != 1 || got.Type != TypeHeartbeat {
		t.Fatalf("frame1: %+v %v", got, err)
	}
	got, err = dec.Next()
	if err != nil || got.Seq != 2 || string(got.Payload) != "hello" {
		t.Fatalf("frame2: %+v %v", got, err)
	}
	if _, err := dec.Next(); !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected EOF after stream, got %v", err)
	}
}

func TestResyncAfterGarbage(t *testing.T) {
	good := EncodeFrame(Frame{Version: 1, Type: TypeReport, Seq: 7, Payload: []byte{0xAA}})
	cases := [][]byte{
		{0x00, 0xFF, 0x12}, // plain garbage
		{0xEB},             // dangling magic byte; good frame starts with another EB
		{0xEB, 0x12, 0x34}, // half magic pair that is not magic
		{0xEB, 0xEB},       // 0xEB 0xEB 0x90: second EB starts the real pair
	}
	for i, garbage := range cases {
		stream := append(append([]byte{}, garbage...), good...)
		dec := NewDecoder(bytes.NewReader(stream), 1024)
		f, err := dec.Next()
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if f.Seq != 7 {
			t.Fatalf("case %d: got seq %d", i, f.Seq)
		}
	}
}

func TestCRCMismatchKeepsStreamAligned(t *testing.T) {
	bad := EncodeFrame(Frame{Version: 1, Type: TypeReport, Seq: 1, Payload: []byte("x")})
	bad[len(bad)-1] ^= 0xFF
	good := EncodeFrame(Frame{Version: 1, Type: TypeReport, Seq: 2})

	dec := NewDecoder(bytes.NewReader(append(bad, good...)), 1024)
	_, err := dec.Next()
	if !errors.Is(err, ErrCRCMismatch) {
		t.Fatalf("expected CRC error, got %v", err)
	}
	f, err := dec.Next()
	if err != nil || f.Seq != 2 {
		t.Fatalf("frame after bad CRC: %+v %v", f, err)
	}
}

func TestOversizedPayloadRejected(t *testing.T) {
	raw := make([]byte, HeaderSize+4+CRCSize)
	raw[0], raw[1] = Magic0, Magic1
	binary.BigEndian.PutUint32(raw[9:13], 10000)
	dec := NewDecoder(bytes.NewReader(raw), 512)
	_, err := dec.Next()
	if !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("expected ErrPayloadTooLarge, got %v", err)
	}
}

func TestTruncatedFrameReturnsUnexpectedEOF(t *testing.T) {
	good := EncodeFrame(Frame{Version: 1, Type: TypeReport, Seq: 9})
	dec := NewDecoder(bytes.NewReader(good[:len(good)-7]), 1024)
	if _, err := dec.Next(); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected unexpected EOF, got %v", err)
	}
}
