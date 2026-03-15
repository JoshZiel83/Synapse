package cua

import "github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"

func (s *Server) buildTools() []core.Tool {
	tools := []core.Tool{
		{
			Name:        "desktop_list_displays",
			Description: "List available displays with stable identifiers, size, origin, scale, and which display currently contains the pointer.",
			InputSchema: objectSchema(nil, nil),
		},
		{
			Name:        "desktop_capture_display",
			Description: "Capture a screenshot of one display. Supports selecting a display and optional output resize.",
			InputSchema: objectSchema(map[string]interface{}{
				"display": selectorSchema(),
				"width":   intSchema("Optional output width in pixels.", 1, 8192),
				"height":  intSchema("Optional output height in pixels.", 1, 8192),
			}, nil),
		},
		{
			Name:        "desktop_get_pointer",
			Description: "Get the current pointer location in absolute desktop coordinates and, when possible, the containing display and display-relative coordinates.",
			InputSchema: objectSchema(nil, nil),
		},
		{
			Name:        "desktop_move_pointer",
			Description: s.writeToolDescription("Move the pointer to a coordinate on the selected display."),
			InputSchema: objectSchema(map[string]interface{}{
				"display":    selectorSchema(),
				"coordinate": coordinateSchema("Target pointer coordinate on the selected display."),
				"smooth":     boolSchema("Whether to move using smooth mouse motion."),
			}, []string{"coordinate"}),
		},
		{
			Name:        "desktop_click",
			Description: s.writeToolDescription("Move to a coordinate on the selected display and click. Supports left, right, middle, double, and triple click behavior."),
			InputSchema: objectSchema(map[string]interface{}{
				"display":    selectorSchema(),
				"coordinate": coordinateSchema("Target click coordinate on the selected display."),
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
			Description: s.writeToolDescription("Drag from one coordinate to another on the selected display."),
			InputSchema: objectSchema(map[string]interface{}{
				"display":          selectorSchema(),
				"start_coordinate": coordinateSchema("Drag start coordinate on the selected display."),
				"end_coordinate":   coordinateSchema("Drag end coordinate on the selected display."),
				"button": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"left", "right", "middle"},
					"description": "Mouse button to hold while dragging. Defaults to left.",
				},
			}, []string{"start_coordinate", "end_coordinate"}),
		},
		{
			Name:        "desktop_scroll",
			Description: s.writeToolDescription("Move to a coordinate on the selected display and scroll by line units."),
			InputSchema: objectSchema(map[string]interface{}{
				"display":    selectorSchema(),
				"coordinate": coordinateSchema("Pointer anchor coordinate on the selected display."),
				"direction": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"up", "down", "left", "right"},
					"description": "Scroll direction.",
				},
				"amount": numberSchema("Scroll amount before the server multiplier is applied. Defaults to 3.", 1, 1000),
			}, []string{"coordinate", "direction"}),
		},
		{
			Name:        "desktop_type_text",
			Description: s.writeToolDescription("Type UTF-8 text into the active application. Optionally click a coordinate first."),
			InputSchema: objectSchema(map[string]interface{}{
				"display":    selectorSchema(),
				"coordinate": coordinateSchema("Optional focus coordinate on the selected display before typing."),
				"text": map[string]interface{}{
					"type":        "string",
					"description": "Text to type.",
				},
			}, []string{"text"}),
		},
		{
			Name:        "desktop_press_keys",
			Description: s.writeToolDescription("Press a key chord or a sequence of key chords. Keys must use DeskAct-supported key names."),
			InputSchema: objectSchema(map[string]interface{}{
				"keys": keyArraySchema("One key chord. Use multiple keys for modifiers plus the final key."),
				"sequence": map[string]interface{}{
					"type":        "array",
					"description": "Optional sequence of key chords. Each item is a keys array like [\"ctrl\", \"l\"].",
					"items": map[string]interface{}{
						"type":  "array",
						"items": map[string]interface{}{"type": "string"},
					},
				},
			}, nil),
		},
		{
			Name:        "desktop_get_keyboard_state",
			Description: "Get modifier and lock-key state from the local desktop.",
			InputSchema: objectSchema(nil, nil),
		},
		{
			Name:        "desktop_wait",
			Description: "Sleep inside the server for a short duration, useful when automations need UI time to settle.",
			InputSchema: objectSchema(map[string]interface{}{
				"duration": numberSchema("Duration in seconds.", 0, 30),
			}, []string{"duration"}),
		},
		{
			Name:        "desktop_list_windows",
			Description: "List visible desktop windows when the current OS supports window enumeration.",
			InputSchema: objectSchema(nil, nil),
		},
		{
			Name:        "computer",
			Description: s.writeToolDescription("Compatibility tool modeled after CUA MCP. Supports display selection while preserving the familiar action-based interface."),
			InputSchema: computerSchema(),
		},
	}

	if s.cfg.IncludeOverviewTool {
		tools = append(tools, core.Tool{
			Name:        "desktop_capture_overview",
			Description: "Capture an annotated overview image containing all detected displays. Useful for choosing a display before taking targeted actions.",
			InputSchema: objectSchema(map[string]interface{}{
				"width":  intSchema("Optional output width in pixels.", 1, 8192),
				"height": intSchema("Optional output height in pixels.", 1, 8192),
			}, nil),
		})
	}

	return tools
}

func (s *Server) writeToolDescription(base string) string {
	if !s.cfg.ReadOnly {
		return base
	}
	return base + " Read-only mode is enabled right now, so mutating calls return a user-approval error until the user disables read-only mode in the Synapse Relay client."
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

func coordinateSchema(description string) map[string]interface{} {
	return map[string]interface{}{
		"type":        "object",
		"description": description,
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
				"description": "Coordinate space. Defaults to the server's configured mode.",
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

func keyArraySchema(description string) map[string]interface{} {
	return map[string]interface{}{
		"type":        "array",
		"description": description,
		"items": map[string]interface{}{
			"type": "string",
		},
	}
}

func computerSchema() map[string]interface{} {
	return objectSchema(map[string]interface{}{
		"action": map[string]interface{}{
			"type": "string",
			"enum": []string{
				"left_click",
				"right_click",
				"middle_click",
				"double_click",
				"triple_click",
				"mouse_move",
				"type",
				"screenshot",
				"wait",
				"scroll",
				"key",
				"keyboard_state",
				"left_click_drag",
				"list_displays",
				"display_overview",
			},
			"description": "Compatibility action. Prefer the dedicated desktop_* tools for new integrations.",
		},
		"display": selectorSchema(),
		"coordinate": map[string]interface{}{
			"type":        "array",
			"description": "Two-element CUA coordinate array.",
			"items":       map[string]interface{}{"type": "number"},
			"minItems":    2,
			"maxItems":    2,
		},
		"start_coordinate": map[string]interface{}{
			"type":        "array",
			"description": "Two-element drag start coordinate array.",
			"items":       map[string]interface{}{"type": "number"},
			"minItems":    2,
			"maxItems":    2,
		},
		"text": map[string]interface{}{
			"type": "string",
		},
		"keys":     keyArraySchema("Key chord for action=key."),
		"duration": numberSchema("Wait duration in seconds for action=wait.", 0, 30),
		"scroll_direction": map[string]interface{}{
			"type":        "string",
			"enum":        []string{"up", "down", "left", "right"},
			"description": "Scroll direction for action=scroll.",
		},
		"scroll_amount":     numberSchema("Scroll amount for action=scroll.", 1, 1000),
		"return_screenshot": boolSchema("Append a display screenshot after executing the action."),
	}, []string{"action"})
}
