package importer

import (
	"testing"

	"github.com/PekingSpades/Synapse/relay/internal/config"
)

func TestReconcileConfigUpdatesFollowLinkedServer(t *testing.T) {
	cfg := &config.Config{
		SyncSources: []config.SyncSourceConfig{
			{
				SourceKind: "codex",
				SourceKey:  "codex:/tmp/codex.json",
				SyncMode:   config.SyncModeFollow,
				Status:     "unknown",
			},
		},
		Servers: []config.ServerConfig{
			{
				Name:          "workspace",
				SyncSourceKey: "codex:/tmp/codex.json",
				Transport:     "stdio",
				Command:       "old-cmd",
				Args:          []string{"--old"},
				Env:           map[string]string{"OLD": "1"},
				Metadata: map[string]interface{}{
					"sourceKind": "codex",
				},
			},
		},
	}

	changed := ReconcileConfig(cfg, []Source{
		{
			Kind:       "codex",
			SourceKey:  "codex:/tmp/codex.json",
			Name:       "Codex",
			ConfigPath: "/tmp/codex.json",
			Available:  true,
			Servers: []ImportedServer{
				{
					SourceKind: "codex",
					SourceKey:  "codex:/tmp/codex.json",
					Name:       "workspace",
					Transport:  "http",
					Endpoint:   "http://127.0.0.1:8080/mcp",
				},
			},
		},
	})

	if !changed {
		t.Fatalf("expected reconcile to report changes")
	}
	if cfg.SyncSources[0].Status != "idle" {
		t.Fatalf("expected sync source status to become idle, got %q", cfg.SyncSources[0].Status)
	}
	if cfg.SyncSources[0].LastSyncedAt == "" {
		t.Fatalf("expected follow sync to update lastSyncedAt")
	}
	if cfg.Servers[0].Transport != "http" {
		t.Fatalf("expected linked server transport to update, got %q", cfg.Servers[0].Transport)
	}
	if cfg.Servers[0].Command != "" {
		t.Fatalf("expected linked server command to clear, got %q", cfg.Servers[0].Command)
	}
	if len(cfg.Servers[0].Args) != 0 {
		t.Fatalf("expected linked server args to update, got %v", cfg.Servers[0].Args)
	}
	if cfg.Servers[0].Endpoint != "http://127.0.0.1:8080/mcp" {
		t.Fatalf("expected linked server endpoint to update, got %q", cfg.Servers[0].Endpoint)
	}
}

func TestReconcileConfigLeavesSnapshotLinkedServerUnchanged(t *testing.T) {
	cfg := &config.Config{
		SyncSources: []config.SyncSourceConfig{
			{
				SourceKind: "codex",
				SourceKey:  "codex:/tmp/codex.json",
				SyncMode:   config.SyncModeSnapshot,
				Status:     "unknown",
			},
		},
		Servers: []config.ServerConfig{
			{
				Name:          "workspace",
				SyncSourceKey: "codex:/tmp/codex.json",
				Transport:     "stdio",
				Command:       "old-cmd",
				Args:          []string{"--old"},
			},
		},
	}

	ReconcileConfig(cfg, []Source{
		{
			Kind:       "codex",
			SourceKey:  "codex:/tmp/codex.json",
			Name:       "Codex",
			ConfigPath: "/tmp/codex.json",
			Available:  true,
			Servers: []ImportedServer{
				{
					SourceKind: "codex",
					SourceKey:  "codex:/tmp/codex.json",
					Name:       "workspace",
					Transport:  "http",
					Endpoint:   "http://127.0.0.1:8080/mcp",
				},
			},
		},
	})

	if cfg.Servers[0].Transport != "stdio" {
		t.Fatalf("expected snapshot-linked server transport to remain unchanged, got %q", cfg.Servers[0].Transport)
	}
	if cfg.Servers[0].Command != "old-cmd" {
		t.Fatalf("expected snapshot-linked server command to remain unchanged, got %q", cfg.Servers[0].Command)
	}
	if cfg.Servers[0].Endpoint != "" {
		t.Fatalf("expected snapshot-linked server endpoint to remain unchanged, got %q", cfg.Servers[0].Endpoint)
	}
}
