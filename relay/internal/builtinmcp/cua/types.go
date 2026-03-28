package cua

import (
	"context"
	"image"

	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
)

type Config struct {
	StableKey            string
	Enabled              bool
	ReadOnly             bool
	RelativeCoordinate   bool
	ImageSize            [2]int
	RelativeSize         [2]int
	ScrollMultiplier     float64
	LogDir               string
	AllowDisplayOverride bool
	IncludeOverviewTool  bool
	DisplaySelector      DisplaySelector
	AuthStore            *runtimeauth.Store
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

type Coordinate struct {
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Space      string  `json:"space,omitempty"`
	BaseWidth  int     `json:"base_width,omitempty"`
	BaseHeight int     `json:"base_height,omitempty"`
}

type CoordinateBase struct {
	Space  string `json:"space"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type ImageInfo struct {
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	MimeType string `json:"mime_type"`
}

type CaptureDisplayResult struct {
	Display        DisplayInfo    `json:"display"`
	Image          ImageInfo      `json:"image"`
	CoordinateBase CoordinateBase `json:"coordinate_base"`
}

type CaptureOverviewResult struct {
	Displays []DisplayInfo `json:"displays"`
	Image    ImageInfo     `json:"image"`
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

type ScrollUnit string

const (
	ScrollUnitLine  ScrollUnit = "line"
	ScrollUnitPixel ScrollUnit = "pixel"
)

type ApplicationInfo struct {
	Name string `json:"name"`
	Path string `json:"path,omitempty"`
}

type ApplicationGroup struct {
	Source string            `json:"source"`
	Apps   []ApplicationInfo `json:"apps"`
}

type ListAppsResult struct {
	Source string             `json:"source"`
	Search string             `json:"search,omitempty"`
	Groups []ApplicationGroup `json:"groups"`
	Total  int                `json:"total"`
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
	SupportedKeyNames() []string
	ModifierNames() []string
	CaptureDisplay(DisplayInfo) (*image.RGBA, error)
	MovePointer(DisplayInfo, int, int, bool) error
	Click(string, int) error
	Drag(DisplayInfo, int, int, int, int, string) error
	Scroll(int, int, ScrollUnit) error
	TypeText(string) error
	PressKeys([]string) error
	KeyboardState() (KeyboardState, error)
	ListWindows() ([]WindowInfo, error)
	ListDesktopApps() ([]ApplicationInfo, error)
	ListInstalledApps() ([]ApplicationInfo, error)
	Close() error
}
