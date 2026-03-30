//go:build !windows

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

func watchShutdownSignals(ctx context.Context, onSignal func(string)) func() {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)

	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		select {
		case sig := <-signals:
			if sig != nil && onSignal != nil {
				onSignal(sig.String())
			}
		case <-ctx.Done():
		}
	}()

	return func() {
		signal.Stop(signals)
		close(signals)
		<-stopped
	}
}
