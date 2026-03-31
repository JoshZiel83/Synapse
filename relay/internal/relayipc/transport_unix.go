//go:build !windows

package relayipc

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
)

func listen(address string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(address), 0o755); err != nil {
		return nil, err
	}
	if err := os.Remove(address); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return net.Listen("unix", address)
}

func dial(ctx context.Context, address string) (net.Conn, error) {
	var dialer net.Dialer
	return dialer.DialContext(ctx, "unix", address)
}
