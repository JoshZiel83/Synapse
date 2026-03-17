package cloud

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type closeRecorder struct {
	mu         sync.Mutex
	closeCount int
	closedCh   chan struct{}
}

func newCloseRecorder() *closeRecorder {
	return &closeRecorder{
		closedCh: make(chan struct{}, 1),
	}
}

func (r *closeRecorder) Close() error {
	r.mu.Lock()
	r.closeCount++
	r.mu.Unlock()

	select {
	case r.closedCh <- struct{}{}:
	default:
	}
	return nil
}

func (r *closeRecorder) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.closeCount
}

func TestCloseConnectionOnContextClosesWhenContextCancels(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	recorder := newCloseRecorder()
	done := make(chan struct{})

	go closeConnectionOnContext(ctx, recorder, done)
	cancel()

	select {
	case <-recorder.closedCh:
	case <-time.After(time.Second):
		t.Fatal("expected connection to close after context cancellation")
	}

	if recorder.Count() != 1 {
		t.Fatalf("expected one close call, got %d", recorder.Count())
	}
}

func TestCloseConnectionOnContextStopsWhenLoopEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	recorder := newCloseRecorder()
	done := make(chan struct{})
	returned := make(chan struct{})

	go func() {
		closeConnectionOnContext(ctx, recorder, done)
		close(returned)
	}()

	close(done)

	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("expected helper to exit when loop ends")
	}

	if recorder.Count() != 0 {
		t.Fatalf("expected no close call when loop ends first, got %d", recorder.Count())
	}
}

func TestNormalizeOperationErrorMapsDeadlineExceeded(t *testing.T) {
	opErr := normalizeOperationError(context.DeadlineExceeded)
	if opErr.Code != "operation_expired" {
		t.Fatalf("expected operation_expired, got %s", opErr.Code)
	}
}

func TestNormalizeOperationErrorMapsCanceled(t *testing.T) {
	opErr := normalizeOperationError(context.Canceled)
	if opErr.Code != "delivery_rejected" {
		t.Fatalf("expected delivery_rejected, got %s", opErr.Code)
	}
}

func TestNormalizeOperationErrorPreservesUnavailableExposure(t *testing.T) {
	opErr := normalizeOperationError(errors.New(`relay exposure "demo" not found`))
	if opErr.Code != "mcp_unavailable" {
		t.Fatalf("expected mcp_unavailable, got %s", opErr.Code)
	}
}

func TestRelayFailureReasonUnwrapsDisconnectError(t *testing.T) {
	err := &disconnectError{err: errors.New("read: websocket: close 1006")}

	if got := relayFailureReason(err); got != "read: websocket: close 1006" {
		t.Fatalf("expected wrapped disconnect reason, got %q", got)
	}
}

func TestRelayFailurePhaseClassifiesCatalogSyncFailures(t *testing.T) {
	if got := relayFailurePhase("catalog sync rejected: exposure invalid"); got != "catalog_sync_rejected" {
		t.Fatalf("expected catalog_sync_rejected, got %q", got)
	}
	if got := relayFailurePhase("read catalog sync response: websocket: close 1006"); got != "catalog_sync_response" {
		t.Fatalf("expected catalog_sync_response, got %q", got)
	}
}
