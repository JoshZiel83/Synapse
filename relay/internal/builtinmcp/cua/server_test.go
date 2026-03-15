package cua

import (
	"context"
	"image"
	"strings"
	"testing"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

type fakeDesktop struct {
	displays []DisplayInfo
	pointer  PointerState
	windows  []WindowInfo
}

func (f *fakeDesktop) Start(context.Context) error { return nil }
func (f *fakeDesktop) Close() error                { return nil }

func (f *fakeDesktop) ListDisplays() ([]DisplayInfo, error) {
	out := make([]DisplayInfo, len(f.displays))
	copy(out, f.displays)
	return out, nil
}

func (f *fakeDesktop) CurrentPointer() (PointerState, error) {
	return f.pointer, nil
}

func (f *fakeDesktop) CaptureDisplay(display DisplayInfo) (*image.RGBA, error) {
	return image.NewRGBA(image.Rect(0, 0, max(display.Size.W, 1), max(display.Size.H, 1))), nil
}

func (f *fakeDesktop) MovePointer(DisplayInfo, int, int, bool) error { return nil }
func (f *fakeDesktop) Click(string, int) error                       { return nil }
func (f *fakeDesktop) Drag(DisplayInfo, int, int, int, int, string) error {
	return nil
}
func (f *fakeDesktop) ScrollLines(int, int) error { return nil }
func (f *fakeDesktop) TypeText(string) error      { return nil }
func (f *fakeDesktop) PressKeys([]string) error   { return nil }
func (f *fakeDesktop) KeyboardState() (KeyboardState, error) {
	return KeyboardState{}, nil
}
func (f *fakeDesktop) ListWindows() ([]WindowInfo, error) {
	out := make([]WindowInfo, len(f.windows))
	copy(out, f.windows)
	return out, nil
}

func TestListToolsHonorsOverviewFlag(t *testing.T) {
	server := NewWithDesktop(Config{
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
	}
}

func TestListDisplaysReturnsStructuredContent(t *testing.T) {
	server := NewWithDesktop(Config{
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

func TestComputerCompatibilityListDisplays(t *testing.T) {
	server := NewWithDesktop(Config{
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

	result, err := server.CallTool(context.Background(), "computer", map[string]interface{}{
		"action": "list_displays",
	})
	if err != nil {
		t.Fatalf("call compatibility tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected successful result")
	}
}

func TestReadOnlyBlocksDesktopWriteTool(t *testing.T) {
	server := NewWithDesktop(Config{
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

func TestReadOnlyBlocksCompatibilityWriteAction(t *testing.T) {
	server := NewWithDesktop(Config{
		ReadOnly:            true,
		ImageSize:           [2]int{1280, 800},
		RelativeSize:        [2]int{1000, 1000},
		IncludeOverviewTool: true,
		DisplaySelector:     DisplaySelector{Mode: "main"},
	}, &fakeDesktop{})

	result, err := server.CallTool(context.Background(), "computer", map[string]interface{}{
		"action": "left_click",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected read-only mode to block compatibility left_click")
	}
}

func TestReadOnlyStillAllowsObservationTools(t *testing.T) {
	server := NewWithDesktop(Config{
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

func max(value, fallback int) int {
	if value > fallback {
		return value
	}
	return fallback
}
