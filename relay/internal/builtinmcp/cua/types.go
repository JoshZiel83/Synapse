package cua

import (
	"context"
	"image"
)

type Config struct {
	ReadOnly             bool
	RelativeCoordinate   bool
	ImageSize            [2]int
	RelativeSize         [2]int
	ScrollMultiplier     float64
	LogDir               string
	AllowDisplayOverride bool
	IncludeOverviewTool  bool
	DisplaySelector      DisplaySelector
}

type DisplaySelector struct {
	Mode       string `json:"mode,omitempty"`
	Index      int    `json:"index,omitempty"`
	ID         int    `json:"id,omitempty"`
	ElectronID int64  `json:"electron_id,omitempty"`
}

type Rect struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

type Size struct {
	W int `json:"w"`
	H int `json:"h"`
}

type DisplayInfo struct {
	ID            int     `json:"id"`
	Index         int     `json:"index"`
	ElectronID    int64   `json:"electron_id"`
	IsMain        bool    `json:"is_main"`
	ContainsMouse bool    `json:"contains_mouse"`
	Origin        Rect    `json:"origin"`
	Size          Size    `json:"size"`
	Scale         float64 `json:"scale"`
}

type PointerState struct {
	AbsoluteX    int          `json:"absolute_x"`
	AbsoluteY    int          `json:"absolute_y"`
	Display      *DisplayInfo `json:"display,omitempty"`
	DisplayX     int          `json:"display_x,omitempty"`
	DisplayY     int          `json:"display_y,omitempty"`
	WithinTarget bool         `json:"within_target"`
}

type Coordinate struct {
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Space      string  `json:"space,omitempty"`
	BaseWidth  int     `json:"base_width,omitempty"`
	BaseHeight int     `json:"base_height,omitempty"`
}

type WindowInfo struct {
	ID          uint64                `json:"id"`
	PID         int                   `json:"pid"`
	Title       string                `json:"title"`
	Bounds      Rect                  `json:"bounds"`
	IsVisible   bool                  `json:"is_visible"`
	IsMinimized bool                  `json:"is_minimized"`
	Displays    []WindowDisplayRegion `json:"displays,omitempty"`
}

type WindowDisplayRegion struct {
	DisplayIndex int  `json:"display_index"`
	DisplayID    int  `json:"display_id"`
	Rect         Rect `json:"rect"`
}

type KeyboardToggleState struct {
	Status    string `json:"status"`
	Supported bool   `json:"supported"`
	Value     *bool  `json:"value,omitempty"`
}

type KeyboardState struct {
	Shift      string              `json:"shift"`
	Ctrl       string              `json:"ctrl"`
	Alt        string              `json:"alt"`
	Cmd        string              `json:"cmd"`
	CapsLock   KeyboardToggleState `json:"caps_lock"`
	NumLock    KeyboardToggleState `json:"num_lock"`
	ScrollLock KeyboardToggleState `json:"scroll_lock"`
}

type Desktop interface {
	Start(context.Context) error
	ListDisplays() ([]DisplayInfo, error)
	CurrentPointer() (PointerState, error)
	CaptureDisplay(DisplayInfo) (*image.RGBA, error)
	MovePointer(DisplayInfo, int, int, bool) error
	Click(string, int) error
	Drag(DisplayInfo, int, int, int, int, string) error
	ScrollLines(int, int) error
	TypeText(string) error
	PressKeys([]string) error
	KeyboardState() (KeyboardState, error)
	ListWindows() ([]WindowInfo, error)
	Close() error
}
