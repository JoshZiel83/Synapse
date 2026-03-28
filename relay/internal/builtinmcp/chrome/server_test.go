package chrome

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
)

func TestDisabledChromeListsStaticToolsAndRequestsPersistentAuthorization(t *testing.T) {
	server, err := New(Config{
		StableKey:  "chrome-disabled",
		InstanceID: "chrome_default",
		Enabled:    false,
		Slim:       true,
		AuthStore:  runtimeauth.NewStore(filepath.Join(t.TempDir(), "runtime-auth.json")),
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
	if structured["authorization_duration"] != "persistent" {
		t.Fatalf("expected persistent authorization hint, got %#v", structured["authorization_duration"])
	}
}
