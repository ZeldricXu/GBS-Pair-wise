// Command gateway accepts device connections on a TCP port and exposes the
// monitoring/control HTTP API.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"gateway/internal/gateway"
)

type envConfig struct {
	tcpAddr     string
	httpAddr    string
	maxPayload  int
	idleTimeout time.Duration
}

func loadEnv() (envConfig, error) {
	cfg := envConfig{
		tcpAddr:     getenv("DEVICE_TCP_ADDR", ":9100"),
		httpAddr:    getenv("HTTP_ADDR", ":8080"),
		maxPayload:  1 << 20,
		idleTimeout: 2 * time.Minute,
	}
	var err error
	if v := os.Getenv("MAX_PAYLOAD_BYTES"); v != "" {
		if _, scanErr := fmt.Sscanf(v, "%d", &cfg.maxPayload); scanErr != nil || cfg.maxPayload <= 0 {
			return cfg, fmt.Errorf("MAX_PAYLOAD_BYTES must be a positive integer, got %q", v)
		}
	}
	if v := os.Getenv("DEVICE_IDLE_TIMEOUT"); v != "" {
		if cfg.idleTimeout, err = time.ParseDuration(v); err != nil || cfg.idleTimeout <= 0 {
			return cfg, fmt.Errorf("DEVICE_IDLE_TIMEOUT must be a positive duration (e.g. 2m), got %q", v)
		}
	}
	return cfg, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	flag.Parse()

	cfg, err := loadEnv()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	logger := log.New(os.Stdout, "gateway ", log.LstdFlags|log.Lmicroseconds)

	srv := gateway.NewServer(gateway.Config{
		TCPAddr:     cfg.tcpAddr,
		HTTPAddr:    cfg.httpAddr,
		MaxPayload:  cfg.maxPayload,
		IdleTimeout: cfg.idleTimeout,
	}, logger)

	if err := srv.Listen(); err != nil {
		logger.Fatalf("listen failed: %v", err)
	}

	go srv.Serve()

	logger.Printf("device TCP listener on %s", srv.TCPAddr())
	logger.Printf("HTTP API on %s", srv.HTTPAddr())

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	sig := <-sigCh
	logger.Printf("received %s, shutting down", sig)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		logger.Printf("shutdown error: %v", err)
	}
}
