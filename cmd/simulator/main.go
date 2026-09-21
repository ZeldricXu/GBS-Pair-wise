// Command simulator is a fake device for end-to-end testing. It connects to
// the gateway, sends reports/heartbeats, and answers downlink commands.
package main

import (
	"flag"
	"io"
	"log"
	"math/rand"
	"net"
	"os"
	"time"

	"gateway/internal/protocol"
)

func main() {
	addr := flag.String("addr", envOr("DEVICE_TCP_ADDR", "127.0.0.1:9100"), "gateway TCP address (host:port)")
	id := flag.String("id", "dev-sim-01", "device id sent via TLV 0x05")
	reportEvery := flag.Duration("report", 800*time.Millisecond, "report interval")
	heartbeatEvery := flag.Duration("heartbeat", 2*time.Second, "heartbeat interval")
	duration := flag.Duration("duration", 0, "stop after this duration (0 = forever)")
	ack := flag.Bool("ack", true, "answer 0x81 commands with a 0x03 ack frame")
	garble := flag.Bool("garble-once", false, "send garbage bytes first to test resync")
	badCRC := flag.Bool("bad-crc-once", false, "send one CRC-corrupted frame to test tolerance")
	flag.Parse()

	logger := log.New(os.Stdout, "sim ", log.LstdFlags|log.Lmicroseconds)

	var deadline <-chan time.Time
	if *duration > 0 {
		timer := time.NewTimer(*duration)
		defer timer.Stop()
		deadline = timer.C
	}

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))

	var conn net.Conn
	var err error

	// (Re)connect loop: a flaky device must keep trying without crashing.
	for {
		conn, err = dialRetry(*addr, logger, deadline)
		if err != nil {
			return // deadline reached / fatal
		}
		break
	}
	defer conn.Close()
	logger.Printf("connected to %s as %s", *addr, *id)

	if *garble {
		_, _ = conn.Write([]byte{0x00, 0xFF, 0xEB, 0x12})
		logger.Printf("sent 4 garbage bytes to test resync")
	}

	readErr := make(chan error, 1)
	go readCommands(conn, *id, *ack, logger, readErr)

	var seq uint32 = 1
	reportTick := time.NewTicker(*reportEvery)
	defer reportTick.Stop()
	heartbeatTick := time.NewTicker(*heartbeatEvery)
	defer heartbeatTick.Stop()

	sendReport := func() {
		temp := int16(200 + rng.Intn(80))       // 20.0C - 27.9C
		humidity := uint16(400 + rng.Intn(300)) // 40.0 - 69.9 %RH
		voltage := uint32(3200 + rng.Intn(200)) // mV
		status := uint32(0)

		tempBuf := make([]byte, 2)
		humBuf := make([]byte, 2)
		payload := protocol.EncodeTLVs(
			protocol.TLV{Type: protocol.TLVDeviceID, Value: []byte(*id)},
			protocol.TLV{Type: protocol.TLVTemp, Value: putInt16(tempBuf, temp)},
			protocol.TLV{Type: protocol.TLVHumidity, Value: putUint16(humBuf, humidity)},
			protocol.TLV{Type: protocol.TLVVoltage, Value: putUint32(make([]byte, 4), voltage)},
			protocol.TLV{Type: protocol.TLVStatus, Value: putUint32(make([]byte, 4), status)},
		)

		if *badCRC && seq == 2 {
			bad := protocol.EncodeFrame(protocol.Frame{Version: 1, Type: protocol.TypeReport, Seq: seq, Payload: payload})
			bad[len(bad)-1] ^= 0xFF
			_, _ = conn.Write(bad)
			logger.Printf("sent CRC-corrupted report seq=%d", seq)
		} else {
			_, err := conn.Write(protocol.EncodeFrame(protocol.Frame{Version: 1, Type: protocol.TypeReport, Seq: seq, Payload: payload}))
			if err != nil {
				logger.Printf("write report failed: %v", err)
				return
			}
		}
		seq++
	}

	sendReport()

	for {
		select {
		case <-deadline:
			logger.Printf("duration elapsed, exiting")
			return
		case err := <-readErr:
			if err != nil && err != io.EOF {
				logger.Printf("reader stopped: %v", err)
			}
			return
		case <-reportTick.C:
			sendReport()
		case <-heartbeatTick.C:
			payload := protocol.EncodeTLV(protocol.TLVDeviceID, []byte(*id))
			if _, err := conn.Write(protocol.EncodeFrame(protocol.Frame{Version: 1, Type: protocol.TypeHeartbeat, Seq: seq, Payload: payload})); err != nil {
				logger.Printf("write heartbeat failed: %v", err)
				return
			}
			seq++
		}
	}
}

func readCommands(conn net.Conn, id string, ack bool, logger *log.Logger, out chan<- error) {
	dec := protocol.NewDecoder(conn, 1<<20)
	for {
		f, err := dec.Next()
		if err != nil {
			out <- err
			return
		}
		if f.Type != protocol.TypeCommand {
			continue
		}
		logger.Printf("got command seq=%d payloadLen=%d", f.Seq, len(f.Payload))
		if !ack {
			continue // simulate a firmware that ignores commands
		}

		// Echo a simple status TLV plus the device id back in the ack.
		payload := protocol.EncodeTLVs(
			protocol.TLV{Type: protocol.TLVDeviceID, Value: []byte(id)},
			protocol.TLV{Type: protocol.TLVStatus, Value: putUint32(make([]byte, 4), 0)},
		)
		reply := protocol.EncodeFrame(protocol.Frame{Version: f.Version, Type: protocol.TypeAck, Seq: f.Seq, Payload: payload})
		if _, err := conn.Write(reply); err != nil {
			out <- err
			return
		}
		logger.Printf("acked command seq=%d", f.Seq)
	}
}

func dialRetry(addr string, logger *log.Logger, stop <-chan time.Time) (net.Conn, error) {
	delay := time.Second
	for {
		conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
		if err == nil {
			return conn, nil
		}
		logger.Printf("dial %s failed: %v (retrying in %s)", addr, err, delay)
		select {
		case <-stop:
			return nil, err
		case <-time.After(delay):
		}
		if delay < 10*time.Second {
			delay *= 2
		}
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func putInt16(b []byte, v int16) []byte   { b[0], b[1] = byte(v>>8), byte(v); return b }
func putUint16(b []byte, v uint16) []byte { b[0], b[1] = byte(v>>8), byte(v); return b }
func putUint32(b []byte, v uint32) []byte {
	b[0], b[1], b[2], b[3] = byte(v>>24), byte(v>>16), byte(v>>8), byte(v)
	return b
}
