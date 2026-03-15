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
	Width   int              `json:"width,omitempty"`
	Height  int              `json:"height,omitempty"`
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

func (s *Server) captureDisplay(raw map[string]interface{}) (core.CallResult, error) {
	var args captureArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}

	display, err := s.resolveDisplay(args.Display)
	if err != nil {
		return errorResult(err.Error()), nil
	}

	img, err := s.desktop.CaptureDisplay(display)
	if err != nil {
		return errorResult(fmt.Sprintf("failed to capture display %d: %v", display.Index, err)), nil
	}

	encoded, err := encodePNGBase64(img, args.Width, args.Height)
	if err != nil {
		return errorResult(fmt.Sprintf("failed to encode screenshot: %v", err)), nil
	}

	return textAndImageResult(
		fmt.Sprintf("Captured display %d (%dx%d).", display.Index, display.Size.W, display.Size.H),
		encoded,
		map[string]interface{}{
			"display": display,
		},
	), nil
}

func (s *Server) captureOverview(raw map[string]interface{}) (core.CallResult, error) {
	var args captureArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
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

	overview, err := renderOverview(captures, displays, args.Width, args.Height)
	if err != nil {
		return errorResult(fmt.Sprintf("failed to render overview: %v", err)), nil
	}

	encoded, err := encodePNGBase64(overview, 0, 0)
	if err != nil {
		return errorResult(fmt.Sprintf("failed to encode overview: %v", err)), nil
	}

	return textAndImageResult(
		fmt.Sprintf("Captured overview for %d display(s).", len(displays)),
		encoded,
		map[string]interface{}{
			"displays": displays,
		},
	), nil
}

func (s *Server) getPointer() core.CallResult {
	state, err := s.desktop.CurrentPointer()
	if err != nil {
		return errorResult(fmt.Sprintf("failed to read pointer state: %v", err))
	}
	return textResult(
		fmt.Sprintf("Pointer is at absolute (%d, %d).", state.AbsoluteX, state.AbsoluteY),
		state,
	)
}

func (s *Server) movePointer(raw map[string]interface{}) (core.CallResult, error) {
	var args movePointerArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
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

func (s *Server) click(raw map[string]interface{}) (core.CallResult, error) {
	var args clickArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
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

func (s *Server) drag(raw map[string]interface{}) (core.CallResult, error) {
	var args dragArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
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

func (s *Server) scroll(raw map[string]interface{}) (core.CallResult, error) {
	var args scrollArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
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
	lines := int(math.Round(amount * s.cfg.ScrollMultiplier))
	if lines < 1 {
		lines = 1
	}

	deltaX, deltaY := 0, 0
	switch strings.TrimSpace(args.Direction) {
	case "up":
		deltaY = lines
	case "down":
		deltaY = -lines
	case "left":
		deltaX = lines
	case "right":
		deltaX = -lines
	default:
		return errorResult(fmt.Sprintf("unsupported scroll direction %q", args.Direction)), nil
	}

	if err := s.desktop.ScrollLines(deltaX, deltaY); err != nil {
		return errorResult(fmt.Sprintf("failed to scroll: %v", err)), nil
	}

	return textResult(
		fmt.Sprintf("Scrolled %s by %d line(s) on display %d at (%d, %d).", args.Direction, lines, display.Index, x, y),
		map[string]interface{}{
			"display":   display,
			"direction": args.Direction,
			"lines":     lines,
			"x":         x,
			"y":         y,
		},
	), nil
}

func (s *Server) typeText(raw map[string]interface{}) (core.CallResult, error) {
	var args typeArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}
	if strings.TrimSpace(args.Text) == "" {
		return errorResult("text is required"), nil
	}

	var display *DisplayInfo
	if args.Coordinate != nil {
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

func (s *Server) pressKeys(raw map[string]interface{}) (core.CallResult, error) {
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
