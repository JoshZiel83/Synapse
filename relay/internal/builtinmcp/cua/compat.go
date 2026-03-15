package cua

import (
	"fmt"
	"strings"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

type computerArgs struct {
	Action           string           `json:"action"`
	Display          *DisplaySelector `json:"display,omitempty"`
	Coordinate       []float64        `json:"coordinate,omitempty"`
	StartCoordinate  []float64        `json:"start_coordinate,omitempty"`
	Text             *string          `json:"text,omitempty"`
	Keys             []string         `json:"keys,omitempty"`
	Duration         *float64         `json:"duration,omitempty"`
	ScrollDirection  *string          `json:"scroll_direction,omitempty"`
	ScrollAmount     *float64         `json:"scroll_amount,omitempty"`
	ReturnScreenshot bool             `json:"return_screenshot,omitempty"`
}

func (s *Server) computer(raw map[string]interface{}) (core.CallResult, error) {
	var args computerArgs
	if err := decodeArgs(raw, &args); err != nil {
		return errorResult(fmt.Sprintf("invalid args: %v", err)), nil
	}

	var (
		result core.CallResult
		err    error
	)

	switch args.Action {
	case "left_click":
		result, err = s.click(map[string]interface{}{
			"display":    args.Display,
			"coordinate": compatCoordinate(args.Coordinate),
			"button":     "left",
			"count":      1,
		})
	case "right_click":
		result, err = s.click(map[string]interface{}{
			"display":    args.Display,
			"coordinate": compatCoordinate(args.Coordinate),
			"button":     "right",
			"count":      1,
		})
	case "middle_click":
		result, err = s.click(map[string]interface{}{
			"display":    args.Display,
			"coordinate": compatCoordinate(args.Coordinate),
			"button":     "middle",
			"count":      1,
		})
	case "double_click":
		result, err = s.click(map[string]interface{}{
			"display":    args.Display,
			"coordinate": compatCoordinate(args.Coordinate),
			"button":     "left",
			"count":      2,
		})
	case "triple_click":
		result, err = s.click(map[string]interface{}{
			"display":    args.Display,
			"coordinate": compatCoordinate(args.Coordinate),
			"button":     "left",
			"count":      3,
		})
	case "mouse_move":
		result, err = s.movePointer(map[string]interface{}{
			"display":    args.Display,
			"coordinate": compatCoordinate(args.Coordinate),
			"smooth":     true,
		})
	case "type":
		payload := map[string]interface{}{
			"text": stringOrEmpty(args.Text),
		}
		if len(args.Coordinate) >= 2 {
			payload["display"] = args.Display
			payload["coordinate"] = compatCoordinate(args.Coordinate)
		}
		result, err = s.typeText(payload)
	case "screenshot":
		result, err = s.captureDisplay(map[string]interface{}{
			"display": args.Display,
		})
	case "wait":
		duration := 3.0
		if args.Duration != nil {
			duration = *args.Duration
		}
		result, err = s.wait(map[string]interface{}{"duration": duration})
	case "scroll":
		direction := ""
		if args.ScrollDirection != nil {
			direction = *args.ScrollDirection
		}
		amount := 3.0
		if args.ScrollAmount != nil {
			amount = *args.ScrollAmount
		}
		result, err = s.scroll(map[string]interface{}{
			"display":    args.Display,
			"coordinate": compatCoordinate(args.Coordinate),
			"direction":  direction,
			"amount":     amount,
		})
	case "key":
		if len(args.Keys) > 0 {
			result, err = s.pressKeys(map[string]interface{}{"keys": args.Keys})
			break
		}
		result, err = s.pressKeys(map[string]interface{}{"sequence": parseCompatibilitySequence(stringOrEmpty(args.Text))})
	case "keyboard_state":
		result = s.keyboardState()
	case "left_click_drag":
		result, err = s.drag(map[string]interface{}{
			"display":          args.Display,
			"start_coordinate": compatCoordinate(args.StartCoordinate),
			"end_coordinate":   compatCoordinate(args.Coordinate),
			"button":           "left",
		})
	case "list_displays":
		result = s.listDisplays()
	case "display_overview":
		result, err = s.captureOverview(map[string]interface{}{})
	default:
		result = errorResult(fmt.Sprintf("unknown compatibility action %q", args.Action))
	}
	if err != nil {
		return result, err
	}

	if args.ReturnScreenshot && args.Action != "screenshot" && args.Action != "display_overview" && !result.IsError {
		screenshot, captureErr := s.captureDisplay(map[string]interface{}{
			"display": args.Display,
		})
		if captureErr == nil && !screenshot.IsError {
			result.Content = append(result.Content, screenshot.Content...)
		}
	}

	return result, nil
}

func compatCoordinate(coord []float64) map[string]interface{} {
	if len(coord) < 2 {
		return map[string]interface{}{}
	}
	return map[string]interface{}{
		"x": coord[0],
		"y": coord[1],
	}
}

func parseCompatibilitySequence(text string) [][]string {
	var sequence [][]string
	for _, chord := range strings.Fields(text) {
		parts := strings.Split(chord, "+")
		filtered := make([]string, 0, len(parts))
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part != "" {
				filtered = append(filtered, part)
			}
		}
		if len(filtered) > 0 {
			sequence = append(sequence, filtered)
		}
	}
	return sequence
}

func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
