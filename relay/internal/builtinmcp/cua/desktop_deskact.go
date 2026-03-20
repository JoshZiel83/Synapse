//go:build desktop_cua

package cua

import (
	"context"
	"fmt"
	"runtime"
	"strings"

	deskact "github.com/PekingSpades/DeskAct"
	"image"
)

type deskactDesktop struct {
	displayOptions   deskact.DisplayOptions
	captureOptions   deskact.CaptureOptions
	mouseSettings    deskact.MouseSettings
	keyboardSettings deskact.KeyboardSettings
	windowOptions    deskact.WindowOptions
}

func newDefaultDesktop() (Desktop, error) {
	if runtime.GOOS == "windows" {
		deskact.InitDPIAwareness()
	}

	return &deskactDesktop{
		displayOptions:   deskact.DefaultDisplayOptions(),
		captureOptions:   deskact.DefaultCaptureOptions(),
		mouseSettings:    deskact.DefaultMouseSettings(),
		keyboardSettings: deskact.DefaultKeyboardSettings(),
		windowOptions:    deskact.DefaultWindowOptions(),
	}, nil
}

func (d *deskactDesktop) Start(context.Context) error {
	return nil
}

func (d *deskactDesktop) Close() error {
	return nil
}

func (d *deskactDesktop) ListDisplays() ([]DisplayInfo, error) {
	rawDisplays := deskact.AllDisplays(d.displayOptions)
	displays := make([]DisplayInfo, 0, len(rawDisplays))
	for _, display := range rawDisplays {
		info := display.Info()
		displays = append(displays, DisplayInfo{
			ID:            info.ID,
			Index:         info.Index,
			ElectronID:    info.ElectronID,
			IsMain:        info.IsMain,
			ContainsMouse: display.ContainsMouse(),
			Origin: Rect{
				X: info.Origin.X,
				Y: info.Origin.Y,
				W: info.Origin.W,
				H: info.Origin.H,
			},
			Size: Size{
				W: info.Size.W,
				H: info.Size.H,
			},
			Scale: info.ScaleFactor,
		})
	}
	return displays, nil
}

func (d *deskactDesktop) SupportedKeyNames() []string {
	return deskact.SupportedKeyNames()
}

func (d *deskactDesktop) ModifierNames() []string {
	modifiers := deskact.ModifierNames()
	result := make([]string, 0, len(modifiers))
	for _, modifier := range modifiers {
		if modifier == "" {
			continue
		}
		result = append(result, string(modifier))
	}
	return result
}

func (d *deskactDesktop) CaptureDisplay(target DisplayInfo) (*image.RGBA, error) {
	_, display, err := d.resolveDisplay(target)
	if err != nil {
		return nil, err
	}
	return display.CaptureRect(0, 0, target.Size.W, target.Size.H, d.captureOptions)
}

func (d *deskactDesktop) MovePointer(target DisplayInfo, x, y int, smooth bool) error {
	_, display, err := d.resolveDisplay(target)
	if err != nil {
		return err
	}
	if smooth {
		return display.MoveSmooth(x, y, d.mouseSettings)
	}
	return display.Move(x, y, d.mouseSettings)
}

func (d *deskactDesktop) Click(button string, count int) error {
	if count <= 0 {
		count = 1
	}
	mouseButton, err := mouseButton(button)
	if err != nil {
		return err
	}
	return deskact.MultiClick(mouseButton, count, d.mouseSettings)
}

func (d *deskactDesktop) Drag(target DisplayInfo, startX, startY, endX, endY int, button string) error {
	_, display, err := d.resolveDisplay(target)
	if err != nil {
		return err
	}
	mouseButton, err := mouseButton(button)
	if err != nil {
		return err
	}
	return display.Drag(startX, startY, endX, endY, mouseButton, d.mouseSettings)
}

func (d *deskactDesktop) Scroll(deltaX, deltaY int, unit ScrollUnit) error {
	switch unit {
	case "", ScrollUnitLine:
		return deskact.ScrollLines(deltaX, deltaY, d.mouseSettings)
	case ScrollUnitPixel:
		return deskact.ScrollPixels(deltaX, deltaY, d.mouseSettings)
	default:
		return fmt.Errorf("unsupported scroll unit %q", unit)
	}
}

func (d *deskactDesktop) TypeText(text string) error {
	deskact.Type(text, 0, d.keyboardSettings)
	return nil
}

func (d *deskactDesktop) PressKeys(keys []string) error {
	if len(keys) == 0 {
		return nil
	}

	key := normalizeKeyName(keys[len(keys)-1])
	modifiers := make([]deskact.Modifier, 0, len(keys)-1)
	for _, raw := range keys[:len(keys)-1] {
		modifier, ok := modifierFor(raw)
		if !ok {
			return fmt.Errorf("unsupported modifier %q", raw)
		}
		modifiers = append(modifiers, modifier)
	}
	return deskact.KeyTap(key, modifiers, d.keyboardSettings)
}

func (d *deskactDesktop) KeyboardState() (KeyboardState, error) {
	state, err := deskact.KeyboardStateCurrent()
	if err != nil {
		return KeyboardState{}, err
	}
	return KeyboardState{
		Shift:      pressStateString(state.Shift),
		Ctrl:       pressStateString(state.Ctrl),
		Alt:        pressStateString(state.Alt),
		Cmd:        pressStateString(state.Cmd),
		CapsLock:   toggleStateValue(state.CapsLock),
		NumLock:    toggleStateValue(state.NumLock),
		ScrollLock: toggleStateValue(state.ScrollLock),
	}, nil
}

func (d *deskactDesktop) ListWindows() ([]WindowInfo, error) {
	windows, err := deskact.ListWindows(d.windowOptions)
	if err != nil {
		return nil, err
	}

	result := make([]WindowInfo, 0, len(windows))
	for _, window := range windows {
		entry := WindowInfo{
			ID:          window.ID,
			PID:         window.PID,
			Title:       window.Title,
			IsVisible:   window.IsVisible,
			IsMinimized: window.IsMinimized,
			Bounds: Rect{
				X: window.Bounds.X,
				Y: window.Bounds.Y,
				W: window.Bounds.W,
				H: window.Bounds.H,
			},
			Displays: make([]WindowDisplayRegion, 0, len(window.DisplayRegions)),
		}
		for _, region := range window.DisplayRegions {
			entry.Displays = append(entry.Displays, WindowDisplayRegion{
				DisplayIndex: region.DisplayIndex,
				DisplayID:    region.DisplayID,
				Rect: Rect{
					X: region.PhysicalRect.X,
					Y: region.PhysicalRect.Y,
					W: region.PhysicalRect.W,
					H: region.PhysicalRect.H,
				},
			})
		}
		result = append(result, entry)
	}
	return result, nil
}

func (d *deskactDesktop) ListDesktopApps() ([]ApplicationInfo, error) {
	apps, err := deskact.DesktopApps()
	result := make([]ApplicationInfo, 0, len(apps))
	for _, app := range apps {
		result = append(result, ApplicationInfo{
			Name: app.Name,
			Path: app.Path,
		})
	}
	if err != nil && len(result) == 0 {
		return nil, err
	}
	return result, nil
}

func (d *deskactDesktop) ListInstalledApps() ([]ApplicationInfo, error) {
	apps, err := deskact.InstalledApps()
	result := make([]ApplicationInfo, 0, len(apps))
	for _, app := range apps {
		result = append(result, ApplicationInfo{
			Name: app.Name,
			Path: app.Path,
		})
	}
	if err != nil && len(result) == 0 {
		return nil, err
	}
	return result, nil
}

func (d *deskactDesktop) resolveDisplay(target DisplayInfo) (*DisplayInfo, *deskact.Display, error) {
	displays, err := d.ListDisplays()
	if err != nil {
		return nil, nil, err
	}

	selector := DisplaySelector{
		Mode:       "electron_id",
		ElectronID: target.ElectronID,
	}
	if selector.ElectronID == 0 {
		selector.Mode = "id"
		selector.ID = target.ID
	}
	if selector.ID == 0 {
		selector.Mode = "index"
		selector.Index = target.Index
	}
	return d.findDisplay(displays, selector)
}

func (d *deskactDesktop) findDisplay(displays []DisplayInfo, selector DisplaySelector) (*DisplayInfo, *deskact.Display, error) {
	rawDisplays := deskact.AllDisplays(d.displayOptions)
	for i := range displays {
		display := displays[i]
		if matchesDisplay(display, selector) {
			for _, raw := range rawDisplays {
				info := raw.Info()
				if info.Index == display.Index && info.ID == display.ID && info.ElectronID == display.ElectronID {
					return &display, raw, nil
				}
			}
		}
	}
	return nil, nil, fmt.Errorf("display could not be resolved")
}

func matchesDisplay(display DisplayInfo, selector DisplaySelector) bool {
	switch selector.Mode {
	case "mouse":
		return display.ContainsMouse
	case "index":
		return display.Index == selector.Index
	case "id":
		return display.ID == selector.ID
	case "electron_id":
		return display.ElectronID == selector.ElectronID
	case "main", "":
		return display.IsMain
	default:
		return false
	}
}

func mouseButton(name string) (deskact.MouseButton, error) {
	switch strings.TrimSpace(strings.ToLower(name)) {
	case "", "left":
		return deskact.MouseButtonLeft, nil
	case "right":
		return deskact.MouseButtonRight, nil
	case "middle", "center":
		return deskact.MouseButtonMiddle, nil
	default:
		return 0, fmt.Errorf("unsupported mouse button %q", name)
	}
}

func modifierFor(name string) (deskact.Modifier, bool) {
	switch normalizeKeyName(name) {
	case "alt":
		return deskact.ModAlt, true
	case "ctrl", "control", "lctrl", "rctrl":
		return deskact.ModCtrl, true
	case "shift", "lshift", "rshift":
		return deskact.ModShift, true
	case "cmd", "command", "meta", "win", "super", "lcmd", "rcmd":
		return deskact.ModCmd, true
	default:
		return deskact.ModNone, false
	}
}

func normalizeKeyName(name string) string {
	switch strings.TrimSpace(strings.ToLower(name)) {
	case "control":
		return "ctrl"
	case "command", "meta", "win", "super":
		return "cmd"
	default:
		return strings.TrimSpace(strings.ToLower(name))
	}
}

func pressStateString(state deskact.KeyboardPressState) string {
	switch state {
	case deskact.KeyboardPressDown:
		return "down"
	case deskact.KeyboardPressUp:
		return "up"
	default:
		return "unsupported"
	}
}

func toggleStateValue(state deskact.KeyboardToggleState) KeyboardToggleState {
	switch state {
	case deskact.KeyboardToggleOn:
		return toggleState("on", true, boolPointer(true))
	case deskact.KeyboardToggleOff:
		return toggleState("off", true, boolPointer(false))
	default:
		return toggleState("unsupported", false, nil)
	}
}
