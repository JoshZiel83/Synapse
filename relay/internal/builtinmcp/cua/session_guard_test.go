package cua

import (
	"errors"
	"testing"

	deskact "github.com/PekingSpades/DeskAct"
	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

type testOverlayController struct {
	startErr    error
	showErr     error
	showCalls   []string
	hideCalls   []string
	captureInfo map[string]overlayCaptureInfo
}

func (t *testOverlayController) Start() error {
	return t.startErr
}

func (t *testOverlayController) Close() error {
	return nil
}

func (t *testOverlayController) Show(runtimeSessionID string) error {
	t.showCalls = append(t.showCalls, runtimeSessionID)
	return t.showErr
}

func (t *testOverlayController) Hide(runtimeSessionID string) {
	t.hideCalls = append(t.hideCalls, runtimeSessionID)
}

func (t *testOverlayController) Update(actionHUDState) {}

func (t *testOverlayController) CaptureInfo(runtimeSessionID string) overlayCaptureInfo {
	if t.captureInfo == nil {
		return overlayCaptureInfo{}
	}
	return t.captureInfo[runtimeSessionID]
}

func TestSessionGuardPrivacyScreenFailureDoesNotActivateSession(t *testing.T) {
	overlay := &testOverlayController{
		showErr: errors.New("overlay unavailable"),
	}
	guard := newSessionGuard(t.TempDir())
	guard.overlay = overlay

	if err := guard.OpenRuntimeSession("session-a"); err != nil {
		t.Fatalf("open session-a: %v", err)
	}

	result := guard.BeforeToolCall("session-a")
	if result == nil || !result.IsError {
		t.Fatalf("expected privacy screen failure result")
	}
	if got := structuredContentCode(result); got != "cua_privacy_screen_unavailable" {
		t.Fatalf("unexpected result code: %q", got)
	}
	if guard.activeRuntimeSessionID != "" {
		t.Fatalf("expected no active runtime session after overlay failure, got %q", guard.activeRuntimeSessionID)
	}
	if state := guard.sessions["session-a"]; state == nil || state.active {
		t.Fatalf("expected session-a to remain inactive after overlay failure: %+v", state)
	}

	overlay.showErr = nil
	if err := guard.OpenRuntimeSession("session-b"); err != nil {
		t.Fatalf("open session-b: %v", err)
	}
	if result := guard.BeforeToolCall("session-b"); result != nil {
		t.Fatalf("expected session-b activation to succeed after overlay recovery, got %+v", result)
	}
	if guard.activeRuntimeSessionID != "session-b" {
		t.Fatalf("expected session-b to become active, got %q", guard.activeRuntimeSessionID)
	}
}

func TestSessionGuardCaptureOptionsWindowsUseDXGI(t *testing.T) {
	restore := setSessionGuardGOOSForTest(t, "windows")
	defer restore()

	guard := newSessionGuard(t.TempDir())
	guard.overlay = &testOverlayController{}

	options, err := guard.CaptureOptions()
	if err != nil {
		t.Fatalf("capture options: %v", err)
	}
	if options.Backend != deskact.CaptureBackendDXGI {
		t.Fatalf("expected DXGI backend, got %q", options.Backend)
	}
}

func TestSessionGuardCaptureOptionsDarwinDefaultToCGDisplay(t *testing.T) {
	restore := setSessionGuardGOOSForTest(t, "darwin")
	defer restore()

	guard := newSessionGuard(t.TempDir())
	guard.overlay = &testOverlayController{}

	options, err := guard.CaptureOptions()
	if err != nil {
		t.Fatalf("capture options: %v", err)
	}
	if options.Backend != deskact.CaptureBackendCGDisplay {
		t.Fatalf("expected CGDisplay backend, got %q", options.Backend)
	}
	if len(options.ExcludedWindowIDs) != 0 {
		t.Fatalf("expected no excluded windows for inactive session, got %+v", options.ExcludedWindowIDs)
	}
}

func TestSessionGuardCaptureOptionsDarwinUseScreenCaptureKitForActiveSession(t *testing.T) {
	restore := setSessionGuardGOOSForTest(t, "darwin")
	defer restore()

	overlay := &testOverlayController{
		captureInfo: map[string]overlayCaptureInfo{
			"session-a": {ExcludedWindowIDs: []uint64{17, 23}},
		},
	}
	guard := newSessionGuard(t.TempDir())
	guard.overlay = overlay

	if err := guard.OpenRuntimeSession("session-a"); err != nil {
		t.Fatalf("open session-a: %v", err)
	}
	if result := guard.BeforeToolCall("session-a"); result != nil {
		t.Fatalf("expected session-a activation to succeed, got %+v", result)
	}

	options, err := guard.CaptureOptions()
	if err != nil {
		t.Fatalf("capture options: %v", err)
	}
	if options.Backend != deskact.CaptureBackendScreenCaptureKit {
		t.Fatalf("expected ScreenCaptureKit backend, got %q", options.Backend)
	}
	if len(options.ExcludedWindowIDs) != 2 || options.ExcludedWindowIDs[0] != 17 || options.ExcludedWindowIDs[1] != 23 {
		t.Fatalf("unexpected excluded windows: %+v", options.ExcludedWindowIDs)
	}
}

func TestSessionGuardCaptureOptionsDarwinRequireOverlayExclusionForActiveSession(t *testing.T) {
	restore := setSessionGuardGOOSForTest(t, "darwin")
	defer restore()

	guard := newSessionGuard(t.TempDir())
	guard.overlay = &testOverlayController{}

	if err := guard.OpenRuntimeSession("session-a"); err != nil {
		t.Fatalf("open session-a: %v", err)
	}
	if result := guard.BeforeToolCall("session-a"); result != nil {
		t.Fatalf("expected session-a activation to succeed, got %+v", result)
	}

	_, err := guard.CaptureOptions()
	if !errors.Is(err, errCUAPrivacyScreenUnavailable) {
		t.Fatalf("expected privacy screen unavailable error, got %v", err)
	}
}

func structuredContentCode(result *core.CallResult) string {
	if result == nil {
		return ""
	}
	content, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		return ""
	}
	code, _ := content["code"].(string)
	return code
}

func setSessionGuardGOOSForTest(t *testing.T, goos string) func() {
	t.Helper()
	previous := sessionGuardGOOS
	sessionGuardGOOS = goos
	return func() {
		sessionGuardGOOS = previous
	}
}
