package cua

import (
	"fmt"
	"strings"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

func (s *Server) buildTools() []core.Tool {
	tools := []core.Tool{
		{
			Name:        "desktop_list_displays",
			Description: s.toolDescription("List available displays with stable identifiers, size, origin, scale, and which display currently contains the pointer."),
			InputSchema: objectSchema(nil, nil),
		},
		{
			Name:        "desktop_capture_display",
			Description: s.toolDescription(s.captureDisplayDescription()),
			InputSchema: objectSchema(map[string]interface{}{
				"display": selectorSchema(),
			}, nil),
		},
		{
			Name:        "desktop_move_pointer",
			Description: s.coordinateActionDescription("Move the pointer to a coordinate on the selected display."),
			InputSchema: objectSchema(map[string]interface{}{
				"display":    selectorSchema(),
				"coordinate": s.coordinateSchema("Target pointer coordinate on the selected display."),
				"smooth":     boolSchema("Whether to move using smooth mouse motion."),
			}, []string{"coordinate"}),
		},
		{
			Name:        "desktop_click",
			Description: s.coordinateActionDescription("Move to a coordinate on the selected display and click. Supports left, right, middle, double, and triple click behavior."),
			InputSchema: objectSchema(map[string]interface{}{
				"display":    selectorSchema(),
				"coordinate": s.coordinateSchema("Target click coordinate on the selected display."),
				"button": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"left", "right", "middle"},
					"description": "Mouse button to click. Defaults to left.",
				},
				"count": intSchema("Number of clicks. Defaults to 1.", 1, 3),
			}, []string{"coordinate"}),
		},
		{
			Name:        "desktop_drag",
			Description: s.coordinateActionDescription("Drag from one coordinate to another on the selected display."),
			InputSchema: objectSchema(map[string]interface{}{
				"display":          selectorSchema(),
				"start_coordinate": s.coordinateSchema("Drag start coordinate on the selected display."),
				"end_coordinate":   s.coordinateSchema("Drag end coordinate on the selected display."),
				"button": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"left", "right", "middle"},
					"description": "Mouse button to hold while dragging. Defaults to left.",
				},
			}, []string{"start_coordinate", "end_coordinate"}),
		},
		{
			Name:        "desktop_scroll",
			Description: s.coordinateActionDescription("Move to a coordinate on the selected display and scroll using line or pixel units."),
			InputSchema: objectSchema(map[string]interface{}{
				"display":    selectorSchema(),
				"coordinate": s.coordinateSchema("Pointer anchor coordinate on the selected display."),
				"direction": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"up", "down", "left", "right"},
					"description": "Scroll direction.",
				},
				"amount": numberSchema("Scroll amount in the selected unit before the server multiplier is applied. Defaults to 3.", 1, 1000),
				"unit": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"line", "pixel"},
					"description": "Scroll unit. Defaults to line.",
				},
			}, []string{"coordinate", "direction"}),
		},
		{
			Name:        "desktop_type_text",
			Description: s.writeToolDescription("Type UTF-8 text into the active application. Optionally click a coordinate first. Prefer desktop_press_keys for shortcuts and non-text keys. If you provide a coordinate, take a fresh screenshot first and use coordinates from the newest image."),
			InputSchema: objectSchema(map[string]interface{}{
				"display":    selectorSchema(),
				"coordinate": s.coordinateSchema("Optional focus coordinate on the selected display before typing."),
				"text": map[string]interface{}{
					"type":        "string",
					"description": "Text to type.",
				},
			}, []string{"text"}),
		},
		{
			Name:        "desktop_press_keys",
			Description: s.writeToolDescription(s.pressKeysDescription() + " Prefer this for shortcuts, navigation keys, and modifier combinations. Prefer desktop_type_text for ordinary text entry."),
			InputSchema: objectSchema(map[string]interface{}{
				"keys": s.keyArraySchema("One key chord. Use multiple keys for modifiers plus the final key."),
				"sequence": map[string]interface{}{
					"type":        "array",
					"description": "Optional sequence of key chords. Each item is a keys array like [\"ctrl\", \"l\"].",
					"items":       s.keyArraySchema("A key chord in the sequence."),
				},
			}, nil),
		},
		{
			Name:        "desktop_get_keyboard_state",
			Description: s.toolDescription("Get modifier and lock-key state from the local desktop."),
			InputSchema: objectSchema(nil, nil),
		},
		{
			Name:        "desktop_wait",
			Description: s.toolDescription("Sleep inside the server for a short duration while the UI settles. Prefer this over shell sleep when coordinating desktop actions."),
			InputSchema: objectSchema(map[string]interface{}{
				"duration": numberSchema("Duration in seconds.", 0, 30),
			}, []string{"duration"}),
		},
		{
			Name:        "desktop_list_windows",
			Description: s.toolDescription("List visible desktop windows when the current OS supports window enumeration."),
			InputSchema: objectSchema(nil, nil),
		},
		{
			Name:        "desktop_list_apps",
			Description: s.toolDescription("List desktop apps and installed apps. Use source to choose desktop, installed, or all, and use search for case-insensitive filtering by app name or path."),
			InputSchema: objectSchema(map[string]interface{}{
				"source": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"desktop", "installed", "all"},
					"description": "Which app source to query. Defaults to all.",
				},
				"search": map[string]interface{}{
					"type":        "string",
					"description": "Optional case-insensitive keyword filter applied to app name and path.",
				},
			}, nil),
		},
	}

	if s.cfg.IncludeOverviewTool {
		tools = append(tools, core.Tool{
			Name:        "desktop_capture_overview",
			Description: s.toolDescription(s.captureOverviewDescription()),
			InputSchema: objectSchema(nil, nil),
		})
	}

	return tools
}

func (s *Server) toolDescription(base string) string {
	if strings.TrimSpace(s.system) == "" {
		return base
	}
	return fmt.Sprintf("Current system: %s. %s", s.system, base)
}

func (s *Server) writeToolDescription(base string) string {
	description := s.toolDescription(base)
	if !s.cfg.ReadOnly {
		return description
	}
	return description + " Read-only mode is enabled right now, so mutating calls return a user-approval error until the user disables read-only mode in the Synapse Relay client."
}

func (s *Server) coordinateActionDescription(base string) string {
	return s.writeToolDescription(base + " Take a fresh screenshot first and use coordinates from the newest image. If the UI changes or a call reports a display change, capture again and recompute coordinates.")
}

func objectSchema(properties map[string]interface{}, required []string) map[string]interface{} {
	if properties == nil {
		properties = map[string]interface{}{}
	}
	return map[string]interface{}{
		"type":       "object",
		"properties": properties,
		"required":   required,
	}
}

func selectorSchema() map[string]interface{} {
	return map[string]interface{}{
		"type":        "object",
		"description": "Optional display selector. When omitted, the server default display is used.",
		"properties": map[string]interface{}{
			"mode": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"main", "mouse", "index", "id", "electron_id"},
				"description": "How to choose the display.",
			},
			"index": map[string]interface{}{"type": "integer"},
			"id":    map[string]interface{}{"type": "integer"},
			"electron_id": map[string]interface{}{
				"type": "integer",
			},
		},
	}
}

func (s *Server) captureDisplayDescription() string {
	base := s.defaultCoordinateBase()
	image := s.captureImageInfo()
	return fmt.Sprintf(
		"Capture a screenshot of one display. The PNG is always resized to the configured image size %dx%d. The default coordinate base for follow-up actions is %s %dx%d. Take a fresh capture immediately before coordinate-based actions, and capture again if the UI or display layout changes.",
		image.Width,
		image.Height,
		base.Space,
		base.Width,
		base.Height,
	)
}

func (s *Server) captureOverviewDescription() string {
	image := s.captureImageInfo()
	return fmt.Sprintf(
		"Capture an annotated overview image containing all detected displays. The PNG is resized to the configured capture size %dx%d and is best used to choose a display before taking a fresh targeted per-display screenshot.",
		image.Width,
		image.Height,
	)
}

func (s *Server) pressKeysDescription() string {
	keyCount := len(s.keyEnumValues())
	if keyCount == 0 {
		return "Press a key chord or a sequence of key chords. Use keys for one chord like [\"ctrl\", \"l\"], or sequence for multiple chords. Accepted aliases include control->ctrl and command/meta/win/super->cmd."
	}
	return fmt.Sprintf(
		"Press a key chord or a sequence of key chords. Use keys for one chord like [\"ctrl\", \"l\"], or sequence for multiple chords. The item enum is populated from %d currently supported DeskAct key names plus accepted aliases such as control->ctrl and command/meta/win/super->cmd.",
		keyCount,
	)
}

func (s *Server) coordinateSchema(description string) map[string]interface{} {
	base := s.defaultCoordinateBase()
	image := s.captureImageInfo()
	schemaDescription := fmt.Sprintf(
		"%s Defaults to %q coordinates with base size %dx%d.",
		description,
		base.Space,
		base.Width,
		base.Height,
	)
	if s.cfg.RelativeCoordinate {
		schemaDescription += fmt.Sprintf(" Screenshots remain %dx%d from image_size even when the default coordinate base uses relative_size.", image.Width, image.Height)
	}
	schemaDescription += " Use base_width and base_height together when your screenshot size differs, or use space=display_pixels for raw display pixels."
	return map[string]interface{}{
		"type":        "object",
		"description": schemaDescription,
		"properties": map[string]interface{}{
			"x": map[string]interface{}{
				"type": "number",
			},
			"y": map[string]interface{}{
				"type": "number",
			},
			"space": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"display_pixels", "image", "relative"},
				"description": fmt.Sprintf("Coordinate space. Defaults to %q for this server.", base.Space),
			},
			"base_width": map[string]interface{}{
				"type":        "integer",
				"description": "Optional source width for image or relative scaling.",
			},
			"base_height": map[string]interface{}{
				"type":        "integer",
				"description": "Optional source height for image or relative scaling.",
			},
		},
		"required": []string{"x", "y"},
	}
}

func intSchema(description string, min, max int) map[string]interface{} {
	return map[string]interface{}{
		"type":        "integer",
		"description": description,
		"minimum":     min,
		"maximum":     max,
	}
}

func numberSchema(description string, min, max float64) map[string]interface{} {
	return map[string]interface{}{
		"type":        "number",
		"description": description,
		"minimum":     min,
		"maximum":     max,
	}
}

func boolSchema(description string) map[string]interface{} {
	return map[string]interface{}{
		"type":        "boolean",
		"description": description,
	}
}

func (s *Server) keyArraySchema(description string) map[string]interface{} {
	itemSchema := map[string]interface{}{
		"type":        "string",
		"description": "DeskAct key name or accepted alias.",
	}
	if enumValues := s.keyEnumValues(); len(enumValues) > 0 {
		itemSchema["enum"] = enumValues
	}
	return map[string]interface{}{
		"type":        "array",
		"description": description,
		"items":       itemSchema,
	}
}

func (s *Server) keyEnumValues() []string {
	seen := make(map[string]struct{})
	values := make([]string, 0, 128)

	add := func(value string) {
		if value == "" {
			return
		}
		if _, exists := seen[value]; exists {
			return
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}

	if s.desktop != nil {
		for _, key := range s.desktop.SupportedKeyNames() {
			add(key)
		}
		for _, modifier := range s.desktop.ModifierNames() {
			add(modifier)
		}
	}

	for _, alias := range []string{"control", "command", "meta", "win", "super"} {
		add(alias)
	}

	return values
}
