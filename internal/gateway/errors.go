package gateway

import "errors"

// Command/connection lifecycle errors.
var (
	ErrCommandTimeout = errors.New("device did not acknowledge command in time")

	errDeviceReconnected = errors.New("device opened a newer connection")
	errDeviceGone        = errors.New("device connection closed")
)
