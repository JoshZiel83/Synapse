package relayagent

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/relayipc"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
)

func TestAgentServesConfigAndStatusOverIPC(t *testing.T) {
	baseDir := t.TempDir()
	paths := relaypaths.ResolveStandaloneProfile(relaypaths.HostPaths{
		HostKind:     relaypaths.HostStandalone,
		SharedRoot:   filepath.Join(baseDir, "shared"),
		ProfilesRoot: filepath.Join(baseDir, "profiles"),
	})
	relaypaths.SetCurrent(paths)

	auth := relayipc.HelloParams{
		Token:       "token-123",
		HostKind:    string(relaypaths.HostStandalone),
		HostVersion: "test",
		ProfileID:   paths.ProfileID,
	}

	agent, err := New(paths, paths.ControlPlanePath, auth, "test")
	if err != nil {
		t.Fatalf("new agent: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := agent.Start(ctx); err != nil {
		t.Fatalf("start agent: %v", err)
	}
	defer func() { _ = agent.Stop() }()

	clientCtx, clientCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer clientCancel()

	client, err := Dial(clientCtx, paths.ControlPlanePath, auth)
	if err != nil {
		t.Fatalf("dial agent: %v", err)
	}
	defer client.Close()

	cfg, err := client.GetConfig(clientCtx)
	if err != nil {
		t.Fatalf("get config: %v", err)
	}
	if cfg.LogLevel != "info" {
		t.Fatalf("expected default log level info, got %q", cfg.LogLevel)
	}

	cfg.Startup.AutoConnect = true
	result, err := client.ApplyConfig(clientCtx, cfg)
	if err != nil {
		t.Fatalf("apply config: %v", err)
	}
	if result.AutoApplied {
		t.Fatalf("expected stopped agent config apply to not auto-apply runtime")
	}

	reloaded, err := client.GetConfig(clientCtx)
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if !reloaded.Startup.AutoConnect {
		t.Fatalf("expected applied config to persist auto_connect")
	}

	status, err := client.GetStatus(clientCtx, false)
	if err != nil {
		t.Fatalf("get status: %v", err)
	}
	if status.State != "stopped" {
		t.Fatalf("expected stopped status, got %q", status.State)
	}

	onDisk, err := config.Load(paths.ConfigPath)
	if err != nil {
		t.Fatalf("load saved config: %v", err)
	}
	if !onDisk.Startup.AutoConnect {
		t.Fatalf("expected config file to persist auto_connect")
	}
}
