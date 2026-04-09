package cua

import (
	"errors"
	"testing"

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

func TestSessionGuardCaptureOptionsWindowsDefaultToDXGI(t *testing.T) {
	restore := setSessionGuardGOOSForTest(t, "windows")
	defer restore()

	guard := newSessionGuard(t.TempDir())
	guard.overlay = &testOverlayController{}

	options, err := guard.CaptureOptions()
	if err != nil {
		t.Fatalf("capture options: %v", err)
	}
	if options.Backend != desktopCaptureBackendDXGI {
		t.Fatalf("expected DXGI backend, got %q", options.Backend)
	}
}

func TestSessionGuardCaptureOptionsWindowsUseGDIForActiveSession(t *testing.T) {
	restore := setSessionGuardGOOSForTest(t, "windows")
	defer restore()

	guard := newSessionGuard(t.TempDir())
	guard.overlay = &testOverlayController{}

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
	if options.Backend != desktopCaptureBackendGDI {
		t.Fatalf("expected GDI backend for active Windows session, got %q", options.Backend)
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
	if options.Backend != desktopCaptureBackendCGDisplay {
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
	if options.Backend != desktopCaptureBackendScreenCaptureKit {
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

func TestRemoteControlDisabledResultIsUnresolvableRuntimeConstraint(t *testing.T) {
	result := remoteControlDisabledResult()
	if !result.IsError {
		t.Fatalf("expected disabled result to be an error")
	}
	if got := structuredContentCode(&result); got != "cua_remote_control_disabled" {
		t.Fatalf("unexpected result code: %q", got)
	}
	denial := structuredContentRelayAccessDenial(t, &result)
	if denial["kind"] != core.RelayAccessDenialKindRuntimeConstraint {
		t.Fatalf("expected runtime_constraint kind, got %#v", denial["kind"])
	}
	if denial["resolution"] != core.RelayAccessDenialResolutionUnresolvable {
		t.Fatalf("expected unresolvable resolution, got %#v", denial["resolution"])
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

func structuredContentRelayAccessDenial(t *testing.T, result *core.CallResult) map[string]interface{} {
	t.Helper()
	if result == nil {
		t.Fatalf("expected result")
	}
	content, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	denial, ok := content["relay_access_denial"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected relay_access_denial map, got %#v", content["relay_access_denial"])
	}
	return denial
}

func setSessionGuardGOOSForTest(t *testing.T, goos string) func() {
	t.Helper()
	previous := sessionGuardGOOS
	sessionGuardGOOS = goos
	return func() {
		sessionGuardGOOS = previous
	}
}
