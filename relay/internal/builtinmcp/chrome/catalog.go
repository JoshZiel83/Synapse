package chrome

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

//go:embed catalog_slim.json
var slimCatalogJSON []byte

//go:embed catalog_full.json
var fullCatalogJSON []byte

func loadCatalog(data []byte) ([]core.Tool, error) {
	var raw []struct {
		Name        string      `json:"name"`
		Description string      `json:"description"`
		InputSchema interface{} `json:"inputSchema"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}

	tools := make([]core.Tool, 0, len(raw))
	for _, item := range raw {
		tools = append(tools, core.Tool{
			Name:        item.Name,
			Description: augmentToolDescription(item.Name, item.Description),
			InputSchema: item.InputSchema,
		})
	}
	return tools, nil
}

func augmentToolDescription(name, description string) string {
	description = strings.TrimSpace(description)

	appendNote := func(note string) string {
		note = strings.TrimSpace(note)
		if note == "" {
			return description
		}
		if description == "" {
			return note
		}
		return description + " " + note
	}

	switch name {
	case "list_pages":
		return appendNote("Use this first when you need tab context or before select_page.")
	case "select_page":
		return appendNote("Call this after list_pages or new_page to choose which page later browser tools should act on.")
	case "new_page":
		return appendNote("After opening the page, wait for it to settle with wait_for or take a fresh snapshot before interacting.")
	case "navigate_page":
		return appendNote("After navigation, use wait_for or take a fresh snapshot before further interactions.")
	case "take_snapshot":
		return appendNote("Prefer this over take_screenshot for structured page inspection and stable element targeting.")
	case "take_screenshot":
		return appendNote("Use this when visual pixels, layout, or rendering details matter. Prefer take_snapshot for structured page inspection.")
	case "click", "fill", "hover", "upload_file":
		return appendNote("Prefer taking a fresh snapshot first so you target the latest page state and element identifiers.")
	case "fill_form":
		return appendNote("Prefer this over repeated fill calls when you need to populate several fields from the same page state.")
	case "press_key":
		return appendNote("Use this for shortcuts, navigation keys, and special key combinations. Prefer fill or type_text for ordinary text entry.")
	case "get_console_message":
		return appendNote("Call list_console_messages first to discover message IDs.")
	case "get_network_request":
		return appendNote("Call list_network_requests first unless you intentionally want the currently selected request.")
	case "wait_for":
		return appendNote("Prefer this after navigation or clicks that trigger asynchronous page updates.")
	case "navigate":
		return appendNote("After navigation, take a fresh screenshot or re-evaluate the page before using stale coordinates or assumptions.")
	case "screenshot":
		return appendNote("Use this for visual inspection. Prefer structured page snapshots when the full browser catalog is available.")
	case "evaluate":
		return appendNote("Use this when page state must be inspected or manipulated with JavaScript and higher-level browser tools are insufficient.")
	}

	return description
}

func staticCatalog(slim bool) ([]core.Tool, error) {
	if slim {
		tools, err := loadCatalog(slimCatalogJSON)
		if err != nil {
			return nil, fmt.Errorf("load slim chrome catalog: %w", err)
		}
		return tools, nil
	}

	tools, err := loadCatalog(fullCatalogJSON)
	if err != nil {
		return nil, fmt.Errorf("load full chrome catalog: %w", err)
	}
	return tools, nil
}
