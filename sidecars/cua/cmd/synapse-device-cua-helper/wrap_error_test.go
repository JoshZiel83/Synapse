// Tests for wrapDeskActError. DeskAct wraps sentinel errors with %w on every
// platform, so the wrap function MUST use errors.Is — direct equality would
// silently downgrade wrapped errors to operation_failed / runtime_constraint
// and break the structured diagnostics the cua.ts layer depends on.

package main

import (
	"fmt"
	"testing"

	deskact "github.com/PekingSpades/DeskAct"
)

func TestWrapDeskActErrorRecognizesWrappedSentinels(t *testing.T) {
	cases := []struct {
		name           string
		err            error
		wantCuaErr     string
		wantSynapseErr string
	}{
		{
			name:           "wrapped ErrCaptureUnsupported",
			err:            fmt.Errorf("wayland session: %w", deskact.ErrCaptureUnsupported),
			wantCuaErr:     "unsupported",
			wantSynapseErr: "runtime_constraint",
		},
		{
			name:           "wrapped ErrCaptureWindowNotFound",
			err:            fmt.Errorf("cgwindow id=12345: %w", deskact.ErrCaptureWindowNotFound),
			wantCuaErr:     "window_not_found",
			wantSynapseErr: "invalid_request",
		},
		{
			name:           "wrapped ErrCapturePermissionDenied",
			err:            fmt.Errorf("AX not trusted: %w", deskact.ErrCapturePermissionDenied),
			wantCuaErr:     "permission_denied",
			wantSynapseErr: "permission_denied",
		},
		{
			name:           "wrapped ErrCaptureFailed",
			err:            fmt.Errorf("PrintWindow blank: %w", deskact.ErrCaptureFailed),
			wantCuaErr:     "capture_failed",
			wantSynapseErr: "runtime_constraint",
		},
		{
			name:           "double-wrapped (errors.Is must still find sentinel)",
			err:            fmt.Errorf("outer: %w", fmt.Errorf("inner: %w", deskact.ErrCaptureUnsupported)),
			wantCuaErr:     "unsupported",
			wantSynapseErr: "runtime_constraint",
		},
		{
			name:           "unrelated error falls through to operation_failed",
			err:            fmt.Errorf("something else"),
			wantCuaErr:     "operation_failed",
			wantSynapseErr: "runtime_constraint",
		},
		{
			name:           "bare sentinel still matches (no regression)",
			err:            deskact.ErrCaptureWindowNotFound,
			wantCuaErr:     "window_not_found",
			wantSynapseErr: "invalid_request",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rpc := wrapDeskActError("TestOp", c.err, nil)
			if rpc == nil {
				t.Fatal("expected non-nil rpcError")
			}
			data, ok := rpc.Data.(map[string]interface{})
			if !ok {
				t.Fatalf("expected map[string]interface{} data, got %T", rpc.Data)
			}
			if got := data["cua_error"]; got != c.wantCuaErr {
				t.Errorf("cua_error = %v, want %q", got, c.wantCuaErr)
			}
			if got := data["synapse_code"]; got != c.wantSynapseErr {
				t.Errorf("synapse_code = %v, want %q", got, c.wantSynapseErr)
			}
			// op + error_text must always be present for diagnostics.
			if got := data["op"]; got != "TestOp" {
				t.Errorf("op = %v, want TestOp", got)
			}
			if _, present := data["error_text"]; !present {
				t.Errorf("error_text missing from data")
			}
		})
	}
}

func TestWrapDeskActErrorNilReturnsNil(t *testing.T) {
	if got := wrapDeskActError("X", nil, nil); got != nil {
		t.Errorf("expected nil for nil error, got %+v", got)
	}
}

func TestWrapDeskActErrorPreservesExtra(t *testing.T) {
	extra := map[string]interface{}{
		"window_id": "12345",
		"pid":       int32(42),
	}
	rpc := wrapDeskActError("ClickWithWindow",
		fmt.Errorf("wrapped: %w", deskact.ErrCaptureUnsupported), extra)
	data := rpc.Data.(map[string]interface{})
	if data["window_id"] != "12345" {
		t.Errorf("extra window_id lost; got %v", data["window_id"])
	}
	if data["pid"] != int32(42) {
		t.Errorf("extra pid lost; got %v", data["pid"])
	}
	if data["op"] != "ClickWithWindow" {
		t.Errorf("op not overridden correctly; got %v", data["op"])
	}
}
