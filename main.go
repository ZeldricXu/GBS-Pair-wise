package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envDur(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		// 也支持纯数字（秒）。
		if n, err := strconv.Atoi(v); err == nil {
			return time.Duration(n) * time.Second
		}
		log.Printf("warn: invalid %s=%q, using default %s", key, v, def)
	}
	return def
}

func main() {
	tcpAddr := ":" + envStr("TCP_PORT", "9000")
	httpAddr := ":" + envStr("HTTP_PORT", "8080")
	cmdTimeout := envDur("CMD_TIMEOUT", 5*time.Second)
	idleTimeout := envDur("READ_IDLE_TIMEOUT", 90*time.Second)

	gw := NewGateway(idleTimeout)

	ln, err := net.Listen("tcp", tcpAddr)
	if err != nil {
		log.Fatalf("listen tcp %s: %v", tcpAddr, err)
	}
	go gw.Serve(ln)
	log.Printf("device TCP listener on %s", tcpAddr)

	httpSrv := &http.Server{
		Addr:              httpAddr,
		Handler:           NewHTTPServer(gw, cmdTimeout).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("HTTP API on %s", httpAddr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http server: %v", err)
		}
	}()

	log.Printf("endpoints: GET /api/devices | GET /api/devices/{id}/latest | POST /api/devices/{id}/command")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Printf("shutting down...")
	ln.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	httpSrv.Shutdown(ctx)
}
