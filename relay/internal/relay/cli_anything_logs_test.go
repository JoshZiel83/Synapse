package relay

import (
	"testing"

	"github.com/PekingSpades/Synapse/relay/internal/mcp"
)

func TestCollectManagedCapabilityStatusesParsesServerMetadata(t *testing.T) {
	servers := []mcp.ServerInfo{
		{
			StableKey: "commandline",
			Name:      "Command Line",
			Metadata: map[string]interface{}{
				"managedCapabilities": []interface{}{
					map[string]interface{}{
						"provider":            "cli-anything",
						"providerDisplayName": "CLI-Anything",
						"command":             "cli-anything-b",
						"module":              "demo-b",
						"version":             "1.0.0",
						"ready":               false,
						"reason":              "wrapper check failed",
					},
					map[string]interface{}{
						"provider":            "lark-cli",
						"providerDisplayName": "Lark CLI",
						"command":             "lark-cli",
						"module":              "",
						"version":             "1.0.4",
						"ready":               true,
						"reason":              "ready",
					},
					map[string]interface{}{
						"provider":            "cli-anything",
						"providerDisplayName": "CLI-Anything",
						"command":             "cli-anything-a",
						"module":              "demo-a",
						"version":             "1.0.0",
						"ready":               true,
						"reason":              "ready",
					},
				},
			},
		},
		{
			StableKey: "filesystem",
			Name:      "Filesystem",
			Metadata:  map[string]interface{}{},
		},
	}

	grouped := collectManagedCapabilityStatuses(servers)
	if len(grouped) != 2 {
		t.Fatalf("expected 2 grouped providers, got %d", len(grouped))
	}
	if len(grouped[0]) != 2 {
		t.Fatalf("expected 2 cli-anything statuses, got %d", len(grouped[0]))
	}

	first := grouped[0][0]
	if first.Command != "cli-anything-a" {
		t.Fatalf("expected sorted first command cli-anything-a, got %q", first.Command)
	}
	if !first.Ready {
		t.Fatalf("expected first capability to be ready")
	}
	if first.ServerName != "Command Line" || first.ServerStableKey != "commandline" {
		t.Fatalf("unexpected server metadata %+v", first)
	}

	second := grouped[0][1]
	if second.Command != "cli-anything-b" {
		t.Fatalf("expected sorted second command cli-anything-b, got %q", second.Command)
	}
	if second.Ready {
		t.Fatalf("expected second capability to be unready")
	}
	if second.Reason != "wrapper check failed" {
		t.Fatalf("unexpected reason %q", second.Reason)
	}

	providerGroup := grouped[1]
	if len(providerGroup) != 1 {
		t.Fatalf("expected 1 lark-cli status, got %d", len(providerGroup))
	}
	if providerGroup[0].Provider != "lark-cli" {
		t.Fatalf("expected lark-cli provider, got %q", providerGroup[0].Provider)
	}
	if providerGroup[0].Command != "lark-cli" {
		t.Fatalf("expected lark-cli command, got %q", providerGroup[0].Command)
	}
}
