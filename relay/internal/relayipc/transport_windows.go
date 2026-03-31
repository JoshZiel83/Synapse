//go:build windows

package relayipc

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

func listen(address string) (net.Listener, error) {
	return winio.ListenPipe(address, &winio.PipeConfig{
		SecurityDescriptor: "D:P(A;;GA;;;OW)",
		InputBufferSize:    64 * 1024,
		OutputBufferSize:   64 * 1024,
	})
}

func dial(ctx context.Context, address string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, address)
}
