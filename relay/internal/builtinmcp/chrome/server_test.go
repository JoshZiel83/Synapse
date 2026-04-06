package chrome

import (
	"context"
	"strings"
	"testing"
)

func TestDisabledChromeListsStaticToolsAndReturnsRelayAccessDenial(t *testing.T) {
	server, err := New(Config{
		StableKey:  "chrome-disabled",
		InstanceID: "chrome_default",
		Enabled:    false,
		Slim:       true,
	})
	if err != nil {
		t.Fatalf("new chrome server: %v", err)
	}

	tools, err := server.ListTools()
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	if len(tools) != 3 {
		t.Fatalf("expected slim static catalog with 3 tools, got %d", len(tools))
	}
	descriptions := make(map[string]string, len(tools))
	for _, tool := range tools {
		descriptions[tool.Name] = tool.Description
	}
	if !strings.Contains(descriptions["navigate"], "After navigation") {
		t.Fatalf("expected navigate description to include post-navigation guidance, got %q", descriptions["navigate"])
	}
	if !strings.Contains(descriptions["screenshot"], "visual inspection") {
		t.Fatalf("expected screenshot description to explain when to use screenshots, got %q", descriptions["screenshot"])
	}

	result, err := server.CallTool(context.Background(), "navigate", map[string]interface{}{
		"url": "https://example.com",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected disabled chrome server to require approval")
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	if structured["capability"] != "chrome" {
		t.Fatalf("expected chrome capability, got %#v", structured["capability"])
	}
	denial, ok := structured["relay_access_denial"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected relay_access_denial map, got %#v", structured["relay_access_denial"])
	}
	if denial["kind"] != "permission_denied" {
		t.Fatalf("expected permission_denied kind, got %#v", denial["kind"])
	}
	if denial["resolution"] != "local_setting" {
		t.Fatalf("expected local_setting resolution, got %#v", denial["resolution"])
	}
}

func TestFullChromeCatalogDescriptionsAddRoutingGuidance(t *testing.T) {
	server, err := New(Config{
		StableKey:  "chrome-full",
		InstanceID: "chrome_default",
		Enabled:    false,
		Slim:       false,
	})
	if err != nil {
		t.Fatalf("new chrome server: %v", err)
	}

	tools, err := server.ListTools()
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}

	descriptions := make(map[string]string, len(tools))
	for _, tool := range tools {
		descriptions[tool.Name] = tool.Description
	}
	if !strings.Contains(descriptions["take_snapshot"], "Prefer this over take_screenshot") {
		t.Fatalf("expected take_snapshot description to prefer structured snapshots, got %q", descriptions["take_snapshot"])
	}
	if !strings.Contains(descriptions["get_console_message"], "list_console_messages first") {
		t.Fatalf("expected get_console_message description to reference list_console_messages, got %q", descriptions["get_console_message"])
	}
	if !strings.Contains(descriptions["select_page"], "list_pages or new_page") {
		t.Fatalf("expected select_page description to mention page selection flow, got %q", descriptions["select_page"])
	}
}
