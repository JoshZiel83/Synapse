package cua

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/png"
	"strings"
	"testing"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
)

type fakeDesktop struct {
	displays       []DisplayInfo
	windows        []WindowInfo
	desktopApps    []ApplicationInfo
	installedApps  []ApplicationInfo
	lastMoveX      int
	lastMoveY      int
	lastMoveSmooth bool
	lastScrollX    int
	lastScrollY    int
	lastScrollUnit ScrollUnit
}

func (f *fakeDesktop) Start(context.Context) error { return nil }
func (f *fakeDesktop) Close() error                { return nil }

func (f *fakeDesktop) ListDisplays() ([]DisplayInfo, error) {
	out := make([]DisplayInfo, len(f.displays))
	copy(out, f.displays)
	return out, nil
}

func (f *fakeDesktop) SupportedKeyNames() []string {
	return []string{"a", "enter", "tab", "esc", "space", "ctrl", "alt", "shift", "cmd", "lctrl", "rctrl"}
}

func (f *fakeDesktop) ModifierNames() []string {
	return []string{"alt", "ctrl", "shift", "cmd"}
}

func (f *fakeDesktop) CaptureDisplay(display DisplayInfo) (*image.RGBA, error) {
	return image.NewRGBA(image.Rect(0, 0, max(display.Size.W, 1), max(display.Size.H, 1))), nil
}

func (f *fakeDesktop) MovePointer(_ DisplayInfo, x, y int, smooth bool) error {
	f.lastMoveX = x
	f.lastMoveY = y
	f.lastMoveSmooth = smooth
	return nil
}
func (f *fakeDesktop) Click(string, int) error { return nil }
func (f *fakeDesktop) Drag(DisplayInfo, int, int, int, int, string) error {
	return nil
}
func (f *fakeDesktop) Scroll(x, y int, unit ScrollUnit) error {
	f.lastScrollX = x
	f.lastScrollY = y
	f.lastScrollUnit = unit
	return nil
}
func (f *fakeDesktop) TypeText(string) error    { return nil }
func (f *fakeDesktop) PressKeys([]string) error { return nil }
func (f *fakeDesktop) KeyboardState() (KeyboardState, error) {
	return KeyboardState{}, nil
}
func (f *fakeDesktop) ListWindows() ([]WindowInfo, error) {
	out := make([]WindowInfo, len(f.windows))
	copy(out, f.windows)
	return out, nil
}
func (f *fakeDesktop) ListDesktopApps() ([]ApplicationInfo, error) {
	out := make([]ApplicationInfo, len(f.desktopApps))
	copy(out, f.desktopApps)
	return out, nil
}
func (f *fakeDesktop) ListInstalledApps() ([]ApplicationInfo, error) {
	out := make([]ApplicationInfo, len(f.installedApps))
	copy(out, f.installedApps)
	return out, nil
}

func TestListToolsHonorsOverviewFlag(t *testing.T) {
	server := NewWithDesktop(Config{
		Enabled:             true,
		ImageSize:           [2]int{1280, 800},
		RelativeSize:        [2]int{1000, 1000},
		IncludeOverviewTool: false,
		DisplaySelector:     DisplaySelector{Mode: "main"},
	}, &fakeDesktop{})

	tools, err := server.ListTools()
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}

	for _, tool := range tools {
		if tool.Name == "desktop_capture_overview" {
			t.Fatalf("expected overview tool to be omitted when disabled")
		}
		if tool.Name == "computer" {
			t.Fatalf("expected compatibility computer tool to be removed")
		}
		if tool.Name == "desktop_get_pointer" {
			t.Fatalf("expected pointer tool to be removed")
		}
		if tool.Name == "desktop_capture_display" {
			schema, ok := tool.InputSchema.(map[string]interface{})
			if !ok {
				t.Fatalf("expected capture display schema map, got %T", tool.InputSchema)
			}
			properties, ok := schema["properties"].(map[string]interface{})
			if !ok {
				t.Fatalf("expected schema properties map, got %T", schema["properties"])
			}
			if _, exists := properties["width"]; exists {
				t.Fatalf("expected capture display schema to omit width")
			}
			if _, exists := properties["height"]; exists {
				t.Fatalf("expected capture display schema to omit height")
			}
			if !strings.Contains(tool.Description, "fresh capture") {
				t.Fatalf("expected capture display description to recommend fresh screenshots, got %q", tool.Description)
			}
		}
		if tool.Name == "desktop_click" && !strings.Contains(tool.Description, "fresh screenshot") {
			t.Fatalf("expected click description to recommend a fresh screenshot, got %q", tool.Description)
		}
		if tool.Name == "desktop_press_keys" {
			schema, ok := tool.InputSchema.(map[string]interface{})
			if !ok {
				t.Fatalf("expected press keys schema map, got %T", tool.InputSchema)
			}
			properties, ok := schema["properties"].(map[string]interface{})
			if !ok {
				t.Fatalf("expected schema properties map, got %T", schema["properties"])
			}
			keys, ok := properties["keys"].(map[string]interface{})
			if !ok {
				t.Fatalf("expected keys schema map, got %T", properties["keys"])
			}
			items, ok := keys["items"].(map[string]interface{})
			if !ok {
				t.Fatalf("expected key item schema map, got %T", keys["items"])
			}
			enumValues, ok := items["enum"].([]string)
			if !ok {
				t.Fatalf("expected key enum slice, got %T", items["enum"])
			}
			if !containsString(enumValues, "enter") || !containsString(enumValues, "control") || !containsString(enumValues, "win") {
				t.Fatalf("expected key enum to include DeskAct keys and accepted aliases, got %+v", enumValues)
			}
			sequence, ok := properties["sequence"].(map[string]interface{})
			if !ok {
				t.Fatalf("expected sequence schema map, got %T", properties["sequence"])
			}
			sequenceItems, ok := sequence["items"].(map[string]interface{})
			if !ok {
				t.Fatalf("expected sequence item schema map, got %T", sequence["items"])
			}
			sequenceKeyItems, ok := sequenceItems["items"].(map[string]interface{})
			if !ok {
				t.Fatalf("expected nested sequence key item schema map, got %T", sequenceItems["items"])
			}
			sequenceEnumValues, ok := sequenceKeyItems["enum"].([]string)
			if !ok {
				t.Fatalf("expected sequence key enum slice, got %T", sequenceKeyItems["enum"])
			}
			if !containsString(sequenceEnumValues, "enter") || !containsString(sequenceEnumValues, "control") || !containsString(sequenceEnumValues, "win") {
				t.Fatalf("expected sequence key enum to include DeskAct keys and accepted aliases, got %+v", sequenceEnumValues)
			}
			if !strings.Contains(tool.Description, "Prefer this for shortcuts") {
				t.Fatalf("expected press keys description to explain shortcut usage, got %q", tool.Description)
			}
		}
		if !strings.Contains(tool.Description, "Current system:") {
			t.Fatalf("expected tool description to include current system context, got %q", tool.Description)
		}
	}
}

func TestRemovedPointerToolReturnsUnknownTool(t *testing.T) {
	server := NewWithDesktop(Config{
		Enabled:         true,
		ImageSize:       [2]int{1280, 800},
		RelativeSize:    [2]int{1000, 1000},
		DisplaySelector: DisplaySelector{Mode: "main"},
	}, &fakeDesktop{})

	result, err := server.CallTool(context.Background(), "desktop_get_pointer", map[string]interface{}{})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected removed tool to return an error")
	}
	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, "unknown tool") {
		t.Fatalf("expected unknown tool error, got %q", content.Text)
	}
}

func TestDisabledCUARequestsPersistentAuthorization(t *testing.T) {
	server := NewWithDesktop(Config{
		Enabled:         false,
		StableKey:       "disabled-cua",
		ImageSize:       [2]int{1280, 800},
		RelativeSize:    [2]int{1000, 1000},
		DisplaySelector: DisplaySelector{Mode: "main"},
	}, &fakeDesktop{})

	result, err := server.CallTool(context.Background(), "desktop_capture_display", nil)
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected disabled CUA server to require approval")
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	if structured["capability"] != "cua" {
		t.Fatalf("expected cua capability, got %#v", structured["capability"])
	}
	if structured["authorization_duration"] != "persistent" {
		t.Fatalf("expected persistent authorization hint, got %#v", structured["authorization_duration"])
	}
}

func TestListDisplaysReturnsStructuredContent(t *testing.T) {
	server := NewWithDesktop(Config{
		Enabled:              true,
		ImageSize:            [2]int{1280, 800},
		RelativeSize:         [2]int{1000, 1000},
		AllowDisplayOverride: true,
		IncludeOverviewTool:  true,
		DisplaySelector:      DisplaySelector{Mode: "main"},
	}, &fakeDesktop{
		displays: []DisplayInfo{
			{
				ID:            1,
				Index:         0,
				ElectronID:    11,
				IsMain:        true,
				ContainsMouse: true,
				Origin:        Rect{X: 0, Y: 0, W: 1920, H: 1080},
				Size:          Size{W: 1920, H: 1080},
				Scale:         1,
			},
		},
	})

	result, err := server.CallTool(context.Background(), "desktop_list_displays", nil)
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected successful result")
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	displays, ok := structured["displays"].([]DisplayInfo)
	if !ok {
		t.Fatalf("expected displays slice, got %T", structured["displays"])
	}
	if len(displays) != 1 || displays[0].ElectronID != 11 {
		t.Fatalf("unexpected displays payload: %+v", displays)
	}
}

func TestRemovedComputerToolReturnsUnknownTool(t *testing.T) {
	server := NewWithDesktop(Config{
		Enabled:              true,
		ImageSize:            [2]int{1280, 800},
		RelativeSize:         [2]int{1000, 1000},
		AllowDisplayOverride: true,
		IncludeOverviewTool:  true,
		DisplaySelector:      DisplaySelector{Mode: "main"},
	}, &fakeDesktop{
		displays: []DisplayInfo{
			{
				ID:         1,
				Index:      0,
				ElectronID: 11,
				IsMain:     true,
				Origin:     Rect{X: 0, Y: 0, W: 1920, H: 1080},
				Size:       Size{W: 1920, H: 1080},
				Scale:      1,
			},
		},
	})

	result, err := server.CallTool(context.Background(), "computer", map[string]interface{}{})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected removed tool to return an error")
	}
	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, "unknown tool") {
		t.Fatalf("expected unknown tool error, got %q", content.Text)
	}
}

func TestReadOnlyBlocksDesktopWriteTool(t *testing.T) {
	server := NewWithDesktop(Config{
		Enabled:             true,
		ReadOnly:            true,
		ImageSize:           [2]int{1280, 800},
		RelativeSize:        [2]int{1000, 1000},
		IncludeOverviewTool: true,
		DisplaySelector:     DisplaySelector{Mode: "main"},
	}, &fakeDesktop{})

	result, err := server.CallTool(context.Background(), "desktop_click", map[string]interface{}{})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected read-only mode to block desktop_click")
	}

	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, "read-only mode") {
		t.Fatalf("expected friendly read-only error, got %q", content.Text)
	}
}

func TestReadOnlyStillAllowsObservationTools(t *testing.T) {
	server := NewWithDesktop(Config{
		Enabled:             true,
		ReadOnly:            true,
		ImageSize:           [2]int{1280, 800},
		RelativeSize:        [2]int{1000, 1000},
		IncludeOverviewTool: true,
		DisplaySelector:     DisplaySelector{Mode: "main"},
	}, &fakeDesktop{
		displays: []DisplayInfo{
			{
				ID:            1,
				Index:         0,
				ElectronID:    11,
				IsMain:        true,
				ContainsMouse: true,
				Origin:        Rect{X: 0, Y: 0, W: 1920, H: 1080},
				Size:          Size{W: 1920, H: 1080},
				Scale:         1,
			},
		},
	})

	result, err := server.CallTool(context.Background(), "desktop_list_displays", nil)
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected observation tool to remain available")
	}
}

func TestReadOnlyGrantIsScopedToMatchingRuntimeSession(t *testing.T) {
	authStore := runtimeauth.NewStore(t.TempDir() + "/runtime-auth.json")
	if err := authStore.OpenSession(runtimeauth.RuntimeSession{
		ID:                "cua-session-a",
		ExposureStableKey: "test-cua-session",
	}); err != nil {
		t.Fatalf("open session-a: %v", err)
	}
	if err := authStore.OpenSession(runtimeauth.RuntimeSession{
		ID:                "cua-session-b",
		ExposureStableKey: "test-cua-session",
	}); err != nil {
		t.Fatalf("open session-b: %v", err)
	}
	if err := authStore.Apply(runtimeauth.Grant{
		InteractionID:     "grant-cua-session-a",
		RuntimeSessionID:  "cua-session-a",
		ExposureStableKey: "test-cua-session",
		Duration:          "session",
		Capability:        "cua",
		Mode:              "control",
	}); err != nil {
		t.Fatalf("apply cua session grant: %v", err)
	}

	server := NewWithDesktop(Config{
		Enabled:         true,
		StableKey:       "test-cua-session",
		ReadOnly:        true,
		ImageSize:       [2]int{1280, 800},
		RelativeSize:    [2]int{1000, 1000},
		DisplaySelector: DisplaySelector{Mode: "main"},
		AuthStore:       authStore,
	}, &fakeDesktop{
		displays: []DisplayInfo{
			{
				ID:         1,
				Index:      0,
				ElectronID: 11,
				IsMain:     true,
				Origin:     Rect{X: 0, Y: 0, W: 1920, H: 1080},
				Size:       Size{W: 1920, H: 1080},
				Scale:      1,
			},
		},
	})
	if err := server.Initialize(); err != nil {
		t.Fatalf("initialize server: %v", err)
	}

	blockedResult, err := server.CallTool(context.Background(), "desktop_press_keys", map[string]interface{}{
		"keys": []string{"enter"},
	})
	if err != nil {
		t.Fatalf("call desktop_press_keys without session: %v", err)
	}
	if !blockedResult.IsError {
		t.Fatalf("expected read-only cua tool to be blocked without runtime session grant")
	}

	otherSessionCtx := runtimeauth.ContextWithRuntimeSessionID(context.Background(), "cua-session-b")
	otherSessionResult, err := server.CallTool(otherSessionCtx, "desktop_press_keys", map[string]interface{}{
		"keys": []string{"enter"},
	})
	if err != nil {
		t.Fatalf("call desktop_press_keys for other session: %v", err)
	}
	if !otherSessionResult.IsError {
		t.Fatalf("expected different runtime session to remain blocked")
	}

	grantedCtx := runtimeauth.ContextWithRuntimeSessionID(context.Background(), "cua-session-a")
	grantedResult, err := server.CallTool(grantedCtx, "desktop_press_keys", map[string]interface{}{
		"keys": []string{"enter"},
	})
	if err != nil {
		t.Fatalf("call desktop_press_keys for granted session: %v", err)
	}
	if grantedResult.IsError {
		t.Fatalf("expected granted runtime session to bypass read-only block")
	}

	authStore.CloseSession("cua-session-a")
	afterCloseResult, err := server.CallTool(grantedCtx, "desktop_press_keys", map[string]interface{}{
		"keys": []string{"enter"},
	})
	if err != nil {
		t.Fatalf("call desktop_press_keys after close: %v", err)
	}
	if !afterCloseResult.IsError {
		t.Fatalf("expected runtime session close to remove cua control grant")
	}
}

func TestDisplayStabilityIsTrackedPerRuntimeSession(t *testing.T) {
	desktop := &fakeDesktop{
		displays: []DisplayInfo{
			{
				ID:         1,
				Index:      0,
				ElectronID: 11,
				IsMain:     true,
				Origin:     Rect{X: 0, Y: 0, W: 1920, H: 1080},
				Size:       Size{W: 1920, H: 1080},
				Scale:      1,
			},
		},
	}
	server := NewWithDesktop(Config{
		Enabled:              true,
		ImageSize:            [2]int{1280, 800},
		RelativeSize:         [2]int{1000, 1000},
		AllowDisplayOverride: true,
		IncludeOverviewTool:  true,
		DisplaySelector:      DisplaySelector{Mode: "main"},
	}, desktop)
	if err := server.Initialize(); err != nil {
		t.Fatalf("initialize server: %v", err)
	}

	sessionA := runtimeauth.ContextWithRuntimeSessionID(context.Background(), "display-session-a")
	initialA, err := server.CallTool(sessionA, "desktop_capture_display", nil)
	if err != nil {
		t.Fatalf("capture display for session-a: %v", err)
	}
	if initialA.IsError {
		t.Fatalf("expected initial capture for session-a to succeed")
	}

	desktop.displays[0].Origin = Rect{X: 0, Y: 0, W: 2560, H: 1440}
	desktop.displays[0].Size = Size{W: 2560, H: 1440}

	sessionB := runtimeauth.ContextWithRuntimeSessionID(context.Background(), "display-session-b")
	initialB, err := server.CallTool(sessionB, "desktop_capture_display", nil)
	if err != nil {
		t.Fatalf("capture display for session-b: %v", err)
	}
	if initialB.IsError {
		t.Fatalf("expected new runtime session to establish a fresh display baseline")
	}

	revisitA, err := server.CallTool(sessionA, "desktop_capture_display", nil)
	if err != nil {
		t.Fatalf("capture display for session-a after change: %v", err)
	}
	if !revisitA.IsError {
		t.Fatalf("expected prior runtime session to detect display configuration change")
	}
	content, ok := revisitA.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", revisitA.Content[0])
	}
	if !strings.Contains(content.Text, "display configuration change") {
		t.Fatalf("expected display change error, got %q", content.Text)
	}
}

func TestCaptureDisplayUsesConfiguredImageSize(t *testing.T) {
	desktop := &fakeDesktop{
		displays: []DisplayInfo{
			{
				ID:         1,
				Index:      0,
				ElectronID: 11,
				IsMain:     true,
				Origin:     Rect{X: 0, Y: 0, W: 1920, H: 1080},
				Size:       Size{W: 1920, H: 1080},
				Scale:      1,
			},
		},
	}
	server := NewWithDesktop(Config{
		Enabled:              true,
		ImageSize:            [2]int{1280, 800},
		RelativeSize:         [2]int{1000, 1000},
		AllowDisplayOverride: true,
		IncludeOverviewTool:  true,
		DisplaySelector:      DisplaySelector{Mode: "main"},
	}, desktop)
	if err := server.Initialize(); err != nil {
		t.Fatalf("initialize server: %v", err)
	}

	result, err := server.CallTool(context.Background(), "desktop_capture_display", nil)
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected successful result")
	}

	width, height := imageDimensionsFromResult(t, result)
	if width != 1280 || height != 800 {
		t.Fatalf("unexpected screenshot size: got %dx%d", width, height)
	}

	structured, ok := result.StructuredContent.(CaptureDisplayResult)
	if !ok {
		t.Fatalf("expected capture display result, got %T", result.StructuredContent)
	}
	if structured.Image.Width != 1280 || structured.Image.Height != 800 {
		t.Fatalf("unexpected image metadata: %+v", structured.Image)
	}
	if structured.CoordinateBase.Space != "image" || structured.CoordinateBase.Width != 1280 || structured.CoordinateBase.Height != 800 {
		t.Fatalf("unexpected coordinate base: %+v", structured.CoordinateBase)
	}
}

func TestCaptureDisplayUsesRelativeBaseWhenEnabled(t *testing.T) {
	desktop := &fakeDesktop{
		displays: []DisplayInfo{
			{
				ID:         1,
				Index:      0,
				ElectronID: 11,
				IsMain:     true,
				Origin:     Rect{X: 0, Y: 0, W: 1920, H: 1080},
				Size:       Size{W: 1920, H: 1080},
				Scale:      1,
			},
		},
	}
	server := NewWithDesktop(Config{
		Enabled:              true,
		RelativeCoordinate:   true,
		ImageSize:            [2]int{1280, 800},
		RelativeSize:         [2]int{1000, 1000},
		AllowDisplayOverride: true,
		IncludeOverviewTool:  true,
		DisplaySelector:      DisplaySelector{Mode: "main"},
	}, desktop)
	if err := server.Initialize(); err != nil {
		t.Fatalf("initialize server: %v", err)
	}

	result, err := server.CallTool(context.Background(), "desktop_capture_display", nil)
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected successful result")
	}

	width, height := imageDimensionsFromResult(t, result)
	if width != 1280 || height != 800 {
		t.Fatalf("unexpected screenshot size: got %dx%d", width, height)
	}

	structured, ok := result.StructuredContent.(CaptureDisplayResult)
	if !ok {
		t.Fatalf("expected capture display result, got %T", result.StructuredContent)
	}
	if structured.Image.Width != 1280 || structured.Image.Height != 800 {
		t.Fatalf("unexpected image metadata: %+v", structured.Image)
	}
	if structured.CoordinateBase.Space != "relative" || structured.CoordinateBase.Width != 1000 || structured.CoordinateBase.Height != 1000 {
		t.Fatalf("unexpected coordinate base: %+v", structured.CoordinateBase)
	}
}

func TestCaptureDisplayRejectsAfterDisplayConfigurationChanges(t *testing.T) {
	desktop := &fakeDesktop{
		displays: []DisplayInfo{
			{
				ID:         1,
				Index:      0,
				ElectronID: 11,
				IsMain:     true,
				Origin:     Rect{X: 0, Y: 0, W: 1920, H: 1080},
				Size:       Size{W: 1920, H: 1080},
				Scale:      1,
			},
		},
	}
	server := NewWithDesktop(Config{
		Enabled:              true,
		ImageSize:            [2]int{1280, 800},
		RelativeSize:         [2]int{1000, 1000},
		AllowDisplayOverride: true,
		IncludeOverviewTool:  true,
		DisplaySelector:      DisplaySelector{Mode: "main"},
	}, desktop)
	if err := server.Initialize(); err != nil {
		t.Fatalf("initialize server: %v", err)
	}

	initial, err := server.CallTool(context.Background(), "desktop_capture_display", nil)
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if initial.IsError {
		t.Fatalf("expected initial capture to succeed")
	}

	desktop.displays[0].Origin = Rect{X: 0, Y: 0, W: 2560, H: 1440}
	desktop.displays[0].Size = Size{W: 2560, H: 1440}

	result, err := server.CallTool(context.Background(), "desktop_capture_display", nil)
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected capture to be rejected after display change")
	}
	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, "display configuration change") {
		t.Fatalf("expected display change error, got %q", content.Text)
	}

	retry, err := server.CallTool(context.Background(), "desktop_capture_display", nil)
	if err != nil {
		t.Fatalf("retry tool: %v", err)
	}
	if retry.IsError {
		t.Fatalf("expected retry to succeed after session refresh")
	}
	structured, ok := retry.StructuredContent.(CaptureDisplayResult)
	if !ok {
		t.Fatalf("expected capture display result, got %T", retry.StructuredContent)
	}
	if structured.Display.Size.W != 2560 || structured.Display.Size.H != 1440 {
		t.Fatalf("expected refreshed display metadata, got %+v", structured.Display.Size)
	}
}

func TestListAppsSupportsSourceAndSearch(t *testing.T) {
	server := NewWithDesktop(Config{
		Enabled:         true,
		ImageSize:       [2]int{1280, 800},
		RelativeSize:    [2]int{1000, 1000},
		DisplaySelector: DisplaySelector{Mode: "main"},
	}, &fakeDesktop{
		desktopApps: []ApplicationInfo{
			{Name: "Chrome", Path: "/home/ubuntu/Desktop/chrome.desktop"},
			{Name: "Terminal", Path: "/home/ubuntu/Desktop/terminal.desktop"},
		},
		installedApps: []ApplicationInfo{
			{Name: "Google Chrome", Path: "/usr/bin/google-chrome"},
			{Name: "Firefox", Path: "/usr/bin/firefox"},
		},
	})

	result, err := server.CallTool(context.Background(), "desktop_list_apps", map[string]interface{}{
		"source": "all",
		"search": "chrome",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected successful app listing")
	}

	structured, ok := result.StructuredContent.(ListAppsResult)
	if !ok {
		t.Fatalf("expected list apps result, got %T", result.StructuredContent)
	}
	if structured.Source != "all" || structured.Search != "chrome" {
		t.Fatalf("unexpected result metadata: %+v", structured)
	}
	if structured.Total != 2 {
		t.Fatalf("expected total 2, got %d", structured.Total)
	}
	if len(structured.Groups) != 2 {
		t.Fatalf("expected 2 groups, got %d", len(structured.Groups))
	}
	if len(structured.Groups[0].Apps) != 1 || structured.Groups[0].Apps[0].Name != "Chrome" {
		t.Fatalf("unexpected desktop apps: %+v", structured.Groups[0].Apps)
	}
	if len(structured.Groups[1].Apps) != 1 || structured.Groups[1].Apps[0].Name != "Google Chrome" {
		t.Fatalf("unexpected installed apps: %+v", structured.Groups[1].Apps)
	}
}

func TestMovePointerClampsScaledCoordinates(t *testing.T) {
	desktop := &fakeDesktop{
		displays: []DisplayInfo{
			{
				ID:         1,
				Index:      0,
				ElectronID: 11,
				IsMain:     true,
				Origin:     Rect{X: 0, Y: 0, W: 1920, H: 1080},
				Size:       Size{W: 1920, H: 1080},
				Scale:      1,
			},
		},
	}
	server := NewWithDesktop(Config{
		Enabled:         true,
		ImageSize:       [2]int{1280, 800},
		RelativeSize:    [2]int{1000, 1000},
		DisplaySelector: DisplaySelector{Mode: "main"},
	}, desktop)
	if err := server.Initialize(); err != nil {
		t.Fatalf("initialize server: %v", err)
	}

	result, err := server.CallTool(context.Background(), "desktop_move_pointer", map[string]interface{}{
		"coordinate": map[string]interface{}{
			"x": 1280,
			"y": 800,
		},
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected move to succeed")
	}
	if desktop.lastMoveX != 1919 || desktop.lastMoveY != 1079 {
		t.Fatalf("expected clamped physical coordinates, got (%d, %d)", desktop.lastMoveX, desktop.lastMoveY)
	}
}

func TestMovePointerRejectsPartialCoordinateBaseOverride(t *testing.T) {
	desktop := &fakeDesktop{
		displays: []DisplayInfo{
			{
				ID:         1,
				Index:      0,
				ElectronID: 11,
				IsMain:     true,
				Origin:     Rect{X: 0, Y: 0, W: 1920, H: 1080},
				Size:       Size{W: 1920, H: 1080},
				Scale:      1,
			},
		},
	}
	server := NewWithDesktop(Config{
		Enabled:         true,
		ImageSize:       [2]int{1280, 800},
		RelativeSize:    [2]int{1000, 1000},
		DisplaySelector: DisplaySelector{Mode: "main"},
	}, desktop)
	if err := server.Initialize(); err != nil {
		t.Fatalf("initialize server: %v", err)
	}

	result, err := server.CallTool(context.Background(), "desktop_move_pointer", map[string]interface{}{
		"coordinate": map[string]interface{}{
			"x":          640,
			"y":          400,
			"space":      "image",
			"base_width": 2000,
		},
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected partial base override to fail")
	}
	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, "base_width and base_height") {
		t.Fatalf("expected coordinate base validation error, got %q", content.Text)
	}
}

func TestScrollSupportsPixelUnit(t *testing.T) {
	desktop := &fakeDesktop{
		displays: []DisplayInfo{
			{
				ID:         1,
				Index:      0,
				ElectronID: 11,
				IsMain:     true,
				Origin:     Rect{X: 0, Y: 0, W: 1920, H: 1080},
				Size:       Size{W: 1920, H: 1080},
				Scale:      1,
			},
		},
	}
	server := NewWithDesktop(Config{
		Enabled:         true,
		ImageSize:       [2]int{1280, 800},
		RelativeSize:    [2]int{1000, 1000},
		DisplaySelector: DisplaySelector{Mode: "main"},
	}, desktop)
	if err := server.Initialize(); err != nil {
		t.Fatalf("initialize server: %v", err)
	}

	result, err := server.CallTool(context.Background(), "desktop_scroll", map[string]interface{}{
		"coordinate": map[string]interface{}{
			"x": 640,
			"y": 400,
		},
		"direction": "down",
		"amount":    24,
		"unit":      "pixel",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected scroll to succeed")
	}
	if desktop.lastScrollX != 0 || desktop.lastScrollY != -24 || desktop.lastScrollUnit != ScrollUnitPixel {
		t.Fatalf("unexpected scroll call: x=%d y=%d unit=%q", desktop.lastScrollX, desktop.lastScrollY, desktop.lastScrollUnit)
	}
}

func TestScrollRejectsUnsupportedUnit(t *testing.T) {
	desktop := &fakeDesktop{
		displays: []DisplayInfo{
			{
				ID:         1,
				Index:      0,
				ElectronID: 11,
				IsMain:     true,
				Origin:     Rect{X: 0, Y: 0, W: 1920, H: 1080},
				Size:       Size{W: 1920, H: 1080},
				Scale:      1,
			},
		},
	}
	server := NewWithDesktop(Config{
		Enabled:         true,
		ImageSize:       [2]int{1280, 800},
		RelativeSize:    [2]int{1000, 1000},
		DisplaySelector: DisplaySelector{Mode: "main"},
	}, desktop)
	if err := server.Initialize(); err != nil {
		t.Fatalf("initialize server: %v", err)
	}

	result, err := server.CallTool(context.Background(), "desktop_scroll", map[string]interface{}{
		"coordinate": map[string]interface{}{
			"x": 640,
			"y": 400,
		},
		"direction": "down",
		"unit":      "page",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected unsupported unit to fail")
	}
	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, "unsupported scroll unit") {
		t.Fatalf("expected unsupported unit error, got %q", content.Text)
	}
}

func imageDimensionsFromResult(t *testing.T, result core.CallResult) (int, int) {
	t.Helper()

	for _, item := range result.Content {
		imageContent, ok := item.(core.ImageContent)
		if !ok {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(imageContent.Data)
		if err != nil {
			t.Fatalf("decode base64 image: %v", err)
		}
		cfg, err := png.DecodeConfig(bytes.NewReader(data))
		if err != nil {
			t.Fatalf("decode png config: %v", err)
		}
		return cfg.Width, cfg.Height
	}

	t.Fatalf("expected image content in result")
	return 0, 0
}

func max(value, fallback int) int {
	if value > fallback {
		return value
	}
	return fallback
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
