package cua

import (
	"fmt"
	"image"
	"math"
	"strings"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

type captureArgs struct {
	Display *DisplaySelector `json:"display,omitempty"`
}

type movePointerArgs struct {
	Display    *DisplaySelector `json:"display,omitempty"`
	Coordinate Coordinate       `json:"coordinate"`
	Smooth     *bool            `json:"smooth,omitempty"`
}

type clickArgs struct {
	Display    *DisplaySelector `json:"display,omitempty"`
	Coordinate Coordinate       `json:"coordinate"`
	Button     string           `json:"button,omitempty"`
	Count      int              `json:"count,omitempty"`
}

type dragArgs struct {
	Display         *DisplaySelector `json:"display,omitempty"`
	StartCoordinate Coordinate       `json:"start_coordinate"`
	EndCoordinate   Coordinate       `json:"end_coordinate"`
	Button          string           `json:"button,omitempty"`
}

type scrollArgs struct {
	Display    *DisplaySelector `json:"display,omitempty"`
	Coordinate Coordinate       `json:"coordinate"`
	Direction  string           `json:"direction"`
	Amount     float64          `json:"amount,omitempty"`
	Unit       string           `json:"unit,omitempty"`
}

type typeArgs struct {
	Display    *DisplaySelector `json:"display,omitempty"`
	Coordinate *Coordinate      `json:"coordinate,omitempty"`
	Text       string           `json:"text"`
}

type pressKeysArgs struct {
	Keys     []string   `json:"keys,omitempty"`
	Sequence [][]string `json:"sequence,omitempty"`
}

type listAppsArgs struct {
	Source string `json:"source,omitempty"`
	Search string `json:"search,omitempty"`
}

type waitArgs struct {
	Duration float64 `json:"duration"`
}

func (s *Server) listDisplays() core.CallResult {
	displays, err := s.desktop.ListDisplays()
	if err != nil {
		return errorResult(fmt.Sprintf("failed to list displays: %v", err))
	}
	return textResult(fmt.Sprintf("Detected %d display(s).", len(displays)), map[string]interface{}{
		"displays": displays,
	})
}

func (s *Server) captureDisplay(runtimeSessionID string, raw map[string]interface{}) (core.CallResult, error) {
	var args captureArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}
	if result, blocked := s.guardStableDisplays(runtimeSessionID); blocked {
		return result, nil
	}

	display, err := s.resolveDisplay(args.Display)
	if err != nil {
		return errorResult(err.Error()), nil
	}

	img, err := s.desktop.CaptureDisplay(display)
	if err != nil {
		return errorResult(fmt.Sprintf("failed to capture display %d: %v", display.Index, err)), nil
	}
	base := s.defaultCoordinateBase()
	imageInfo := s.captureImageInfo()
	img = resizeImageToSize(img, imageInfo.Width, imageInfo.Height)

	encoded, err := encodePNGBase64(img)
	if err != nil {
		return errorResult(fmt.Sprintf("failed to encode screenshot: %v", err)), nil
	}

	return textAndImageResult(
		fmt.Sprintf(
			"Captured display %d. Output image is %dx%d. Default %s coordinate base is %dx%d.",
			display.Index,
			imageInfo.Width,
			imageInfo.Height,
			base.Space,
			base.Width,
			base.Height,
		),
		encoded,
		CaptureDisplayResult{
			Display:        display,
			Image:          imageInfo,
			CoordinateBase: base,
		},
	), nil
}

func (s *Server) captureOverview(runtimeSessionID string, raw map[string]interface{}) (core.CallResult, error) {
	var args captureArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}
	if result, blocked := s.guardStableDisplays(runtimeSessionID); blocked {
		return result, nil
	}

	displays, err := s.desktop.ListDisplays()
	if err != nil {
		return errorResult(fmt.Sprintf("failed to list displays: %v", err)), nil
	}
	captures := make(map[int]*image.RGBA, len(displays))
	for _, display := range displays {
		img, captureErr := s.desktop.CaptureDisplay(display)
		if captureErr != nil {
			return errorResult(fmt.Sprintf("failed to capture display %d: %v", display.Index, captureErr)), nil
		}
		captures[display.Index] = img
	}

	overview, err := renderOverview(captures, displays)
	if err != nil {
		return errorResult(fmt.Sprintf("failed to render overview: %v", err)), nil
	}
	imageInfo := s.captureImageInfo()
	overview = resizeImageToSize(overview, imageInfo.Width, imageInfo.Height)

	encoded, err := encodePNGBase64(overview)
	if err != nil {
		return errorResult(fmt.Sprintf("failed to encode overview: %v", err)), nil
	}

	return textAndImageResult(
		fmt.Sprintf("Captured overview for %d display(s). Output image is %dx%d.", len(displays), imageInfo.Width, imageInfo.Height),
		encoded,
		CaptureOverviewResult{
			Displays: displays,
			Image:    imageInfo,
		},
	), nil
}

func (s *Server) movePointer(runtimeSessionID string, raw map[string]interface{}) (core.CallResult, error) {
	var args movePointerArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}
	if result, blocked := s.guardStableDisplays(runtimeSessionID); blocked {
		return result, nil
	}

	display, err := s.resolveDisplay(args.Display)
	if err != nil {
		return errorResult(err.Error()), nil
	}
	x, y, err := s.convertCoordinate(display, args.Coordinate)
	if err != nil {
		return errorResult(err.Error()), nil
	}
	smooth := args.Smooth != nil && *args.Smooth
	if err := s.desktop.MovePointer(display, x, y, smooth); err != nil {
		return errorResult(fmt.Sprintf("failed to move pointer: %v", err)), nil
	}

	return textResult(
		fmt.Sprintf("Moved pointer to display %d at (%d, %d).", display.Index, x, y),
		map[string]interface{}{
			"display": display,
			"x":       x,
			"y":       y,
		},
	), nil
}

func (s *Server) click(runtimeSessionID string, raw map[string]interface{}) (core.CallResult, error) {
	var args clickArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}
	if result, blocked := s.guardStableDisplays(runtimeSessionID); blocked {
		return result, nil
	}

	display, err := s.resolveDisplay(args.Display)
	if err != nil {
		return errorResult(err.Error()), nil
	}
	x, y, err := s.convertCoordinate(display, args.Coordinate)
	if err != nil {
		return errorResult(err.Error()), nil
	}
	if err := s.desktop.MovePointer(display, x, y, false); err != nil {
		return errorResult(fmt.Sprintf("failed to position pointer: %v", err)), nil
	}

	button := strings.TrimSpace(args.Button)
	if button == "" {
		button = "left"
	}
	count := args.Count
	if count <= 0 {
		count = 1
	}
	if err := s.desktop.Click(button, count); err != nil {
		return errorResult(fmt.Sprintf("failed to click: %v", err)), nil
	}

	return textResult(
		fmt.Sprintf("Clicked %s button %d time(s) on display %d at (%d, %d).", button, count, display.Index, x, y),
		map[string]interface{}{
			"display": display,
			"button":  button,
			"count":   count,
			"x":       x,
			"y":       y,
		},
	), nil
}

func (s *Server) drag(runtimeSessionID string, raw map[string]interface{}) (core.CallResult, error) {
	var args dragArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}
	if result, blocked := s.guardStableDisplays(runtimeSessionID); blocked {
		return result, nil
	}

	display, err := s.resolveDisplay(args.Display)
	if err != nil {
		return errorResult(err.Error()), nil
	}
	startX, startY, err := s.convertCoordinate(display, args.StartCoordinate)
	if err != nil {
		return errorResult(err.Error()), nil
	}
	endX, endY, err := s.convertCoordinate(display, args.EndCoordinate)
	if err != nil {
		return errorResult(err.Error()), nil
	}

	button := strings.TrimSpace(args.Button)
	if button == "" {
		button = "left"
	}
	if err := s.desktop.Drag(display, startX, startY, endX, endY, button); err != nil {
		return errorResult(fmt.Sprintf("failed to drag: %v", err)), nil
	}

	return textResult(
		fmt.Sprintf("Dragged on display %d from (%d, %d) to (%d, %d).", display.Index, startX, startY, endX, endY),
		map[string]interface{}{
			"display": display,
			"button":  button,
			"start":   map[string]int{"x": startX, "y": startY},
			"end":     map[string]int{"x": endX, "y": endY},
		},
	), nil
}

func (s *Server) scroll(runtimeSessionID string, raw map[string]interface{}) (core.CallResult, error) {
	var args scrollArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}
	if result, blocked := s.guardStableDisplays(runtimeSessionID); blocked {
		return result, nil
	}

	display, err := s.resolveDisplay(args.Display)
	if err != nil {
		return errorResult(err.Error()), nil
	}
	x, y, err := s.convertCoordinate(display, args.Coordinate)
	if err != nil {
		return errorResult(err.Error()), nil
	}
	if err := s.desktop.MovePointer(display, x, y, false); err != nil {
		return errorResult(fmt.Sprintf("failed to position pointer: %v", err)), nil
	}

	amount := args.Amount
	if amount <= 0 {
		amount = 3
	}
	value := int(math.Round(amount * s.cfg.ScrollMultiplier))
	if value < 1 {
		value = 1
	}
	unit := normalizeScrollUnit(args.Unit)

	deltaX, deltaY := 0, 0
	switch strings.TrimSpace(args.Direction) {
	case "up":
		deltaY = value
	case "down":
		deltaY = -value
	case "left":
		deltaX = value
	case "right":
		deltaX = -value
	default:
		return errorResult(fmt.Sprintf("unsupported scroll direction %q", args.Direction)), nil
	}

	if err := validateScrollUnit(unit); err != nil {
		return errorResult(err.Error()), nil
	}
	if err := s.desktop.Scroll(deltaX, deltaY, unit); err != nil {
		return errorResult(fmt.Sprintf("failed to scroll: %v", err)), nil
	}

	return textResult(
		fmt.Sprintf("Scrolled %s by %d %s(s) on display %d at (%d, %d).", args.Direction, value, unit, display.Index, x, y),
		map[string]interface{}{
			"display":   display,
			"direction": args.Direction,
			"amount":    value,
			"unit":      unit,
			"x":         x,
			"y":         y,
		},
	), nil
}

func normalizeScrollUnit(unit string) ScrollUnit {
	switch strings.TrimSpace(strings.ToLower(unit)) {
	case "", "line", "lines":
		return ScrollUnitLine
	case "pixel", "pixels":
		return ScrollUnitPixel
	default:
		return ScrollUnit(strings.TrimSpace(strings.ToLower(unit)))
	}
}

func validateScrollUnit(unit ScrollUnit) error {
	switch unit {
	case ScrollUnitLine, ScrollUnitPixel:
		return nil
	default:
		return fmt.Errorf("unsupported scroll unit %q", unit)
	}
}

func (s *Server) typeText(runtimeSessionID string, raw map[string]interface{}) (core.CallResult, error) {
	var args typeArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}
	if strings.TrimSpace(args.Text) == "" {
		return errorResult("text is required"), nil
	}

	var display *DisplayInfo
	if args.Coordinate != nil {
		if result, blocked := s.guardStableDisplays(runtimeSessionID); blocked {
			return result, nil
		}
		resolvedDisplay, err := s.resolveDisplay(args.Display)
		if err != nil {
			return errorResult(err.Error()), nil
		}
		x, y, err := s.convertCoordinate(resolvedDisplay, *args.Coordinate)
		if err != nil {
			return errorResult(err.Error()), nil
		}
		if err := s.desktop.MovePointer(resolvedDisplay, x, y, false); err != nil {
			return errorResult(fmt.Sprintf("failed to position pointer: %v", err)), nil
		}
		if err := s.desktop.Click("left", 1); err != nil {
			return errorResult(fmt.Sprintf("failed to focus target before typing: %v", err)), nil
		}
		display = &resolvedDisplay
	}

	if err := s.desktop.TypeText(args.Text); err != nil {
		return errorResult(fmt.Sprintf("failed to type text: %v", err)), nil
	}

	return textResult(
		fmt.Sprintf("Typed %d character(s).", len([]rune(args.Text))),
		map[string]interface{}{
			"display": display,
			"text":    args.Text,
		},
	), nil
}

func (s *Server) pressKeys(_ string, raw map[string]interface{}) (core.CallResult, error) {
	var args pressKeysArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}

	if len(args.Sequence) == 0 && len(args.Keys) == 0 {
		return errorResult("keys or sequence is required"), nil
	}
	if len(args.Sequence) == 0 {
		args.Sequence = [][]string{args.Keys}
	}
	for _, chord := range args.Sequence {
		if len(chord) == 0 {
			continue
		}
		if err := s.desktop.PressKeys(chord); err != nil {
			return errorResult(fmt.Sprintf("failed to press keys %v: %v", chord, err)), nil
		}
	}

	return textResult(
		fmt.Sprintf("Pressed %d key chord(s).", len(args.Sequence)),
		map[string]interface{}{
			"sequence": args.Sequence,
		},
	), nil
}

func (s *Server) keyboardState() core.CallResult {
	state, err := s.desktop.KeyboardState()
	if err != nil {
		return errorResult(fmt.Sprintf("failed to read keyboard state: %v", err))
	}
	return textResult("Read keyboard state.", state)
}

func (s *Server) listWindows() core.CallResult {
	windows, err := s.desktop.ListWindows()
	if err != nil {
		return errorResult(fmt.Sprintf("failed to list windows: %v", err))
	}
	return textResult(
		fmt.Sprintf("Listed %d window(s).", len(windows)),
		map[string]interface{}{
			"windows": windows,
		},
	)
}

func (s *Server) listApps(raw map[string]interface{}) (core.CallResult, error) {
	var args listAppsArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}

	source := strings.TrimSpace(strings.ToLower(args.Source))
	if source == "" {
		source = "all"
	}

	requestedSources := []string{}
	switch source {
	case "desktop":
		requestedSources = []string{"desktop"}
	case "installed":
		requestedSources = []string{"installed"}
	case "all":
		requestedSources = []string{"desktop", "installed"}
	default:
		return errorResult(fmt.Sprintf("unsupported app source %q", args.Source)), nil
	}

	search := strings.TrimSpace(args.Search)
	groups := make([]ApplicationGroup, 0, len(requestedSources))
	total := 0
	for _, requestedSource := range requestedSources {
		apps, err := s.listAppsBySource(requestedSource)
		if err != nil {
			return errorResult(fmt.Sprintf("failed to list %s apps: %v", requestedSource, err)), nil
		}
		apps = filterApplications(apps, search)
		total += len(apps)
		groups = append(groups, ApplicationGroup{
			Source: requestedSource,
			Apps:   apps,
		})
	}

	return textResult(
		describeAppListing(groups, search),
		ListAppsResult{
			Source: source,
			Search: search,
			Groups: groups,
			Total:  total,
		},
	), nil
}

func (s *Server) listAppsBySource(source string) ([]ApplicationInfo, error) {
	switch source {
	case "desktop":
		return s.desktop.ListDesktopApps()
	case "installed":
		return s.desktop.ListInstalledApps()
	default:
		return nil, fmt.Errorf("unsupported app source %q", source)
	}
}

func filterApplications(apps []ApplicationInfo, search string) []ApplicationInfo {
	if len(apps) == 0 {
		return nil
	}
	if strings.TrimSpace(search) == "" {
		filtered := make([]ApplicationInfo, len(apps))
		copy(filtered, apps)
		return filtered
	}

	needle := strings.ToLower(search)
	filtered := make([]ApplicationInfo, 0, len(apps))
	for _, app := range apps {
		if strings.Contains(strings.ToLower(app.Name), needle) || strings.Contains(strings.ToLower(app.Path), needle) {
			filtered = append(filtered, app)
		}
	}
	return filtered
}

func describeAppListing(groups []ApplicationGroup, search string) string {
	if len(groups) == 0 {
		return "Listed 0 apps."
	}

	parts := make([]string, 0, len(groups))
	for _, group := range groups {
		parts = append(parts, fmt.Sprintf("%d %s app(s)", len(group.Apps), group.Source))
	}

	if strings.TrimSpace(search) == "" {
		return fmt.Sprintf("Listed %s.", strings.Join(parts, " and "))
	}
	return fmt.Sprintf("Matched %s for search %q.", strings.Join(parts, " and "), search)
}

func (s *Server) wait(raw map[string]interface{}) (core.CallResult, error) {
	var args waitArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}
	if args.Duration < 0 || args.Duration > 30 {
		return errorResult("duration must be between 0 and 30 seconds"), nil
	}
	time.Sleep(time.Duration(args.Duration * float64(time.Second)))
	return textResult(fmt.Sprintf("Waited %.2f second(s).", args.Duration), map[string]interface{}{
		"duration": args.Duration,
	}), nil
}
