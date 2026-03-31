package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/cloud"
	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/relay"
	"github.com/PekingSpades/Synapse/relay/internal/relayagent"
	"github.com/PekingSpades/Synapse/relay/internal/relaycontroller"
	"github.com/PekingSpades/Synapse/relay/internal/relayipc"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	agentStartupTimeout = 10 * time.Second
	agentCallTimeout    = 20 * time.Second
)

type agentSession struct {
	paths   relaypaths.ResolvedPaths
	address string
	token   string
	client  *relayagent.Client
	cmd     *exec.Cmd
}

func newStandalonePaths() relaypaths.ResolvedPaths {
	return relaypaths.ResolveStandaloneProfile(relaypaths.DefaultHostPaths(relaypaths.HostStandalone))
}

func spawnStandaloneAgent(version string, paths relaypaths.ResolvedPaths) (*agentSession, error) {
	if err := relaypaths.Ensure(paths); err != nil {
		return nil, err
	}

	token, err := randomToken()
	if err != nil {
		return nil, err
	}

	commandPath, extraArgs, err := resolveAgentCommand()
	if err != nil {
		return nil, err
	}

	args := append(extraArgs,
		"--host-kind="+string(relaypaths.HostStandalone),
		"--shared-root="+paths.HostPaths.SharedRoot,
		"--profiles-root="+paths.HostPaths.ProfilesRoot,
		"--profile-id="+paths.ProfileID,
		"--ipc-endpoint="+paths.ControlPlanePath,
		"--ipc-token="+token,
	)

	cmd := exec.Command(commandPath, args...)
	configureAgentCommand(cmd)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start relay agent: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), agentStartupTimeout)
	defer cancel()

	client, err := waitForAgent(ctx, paths.ControlPlanePath, relayipc.HelloParams{
		Token:       token,
		HostKind:    string(relaypaths.HostStandalone),
		HostVersion: version,
		ProfileID:   paths.ProfileID,
	})
	if err != nil {
		_ = cmd.Process.Kill()
		return nil, err
	}

	return &agentSession{
		paths:   paths,
		address: paths.ControlPlanePath,
		token:   token,
		client:  client,
		cmd:     cmd,
	}, nil
}

func waitForAgent(ctx context.Context, address string, hello relayipc.HelloParams) (*relayagent.Client, error) {
	var lastErr error
	for {
		client, err := relayagent.Dial(ctx, address, hello)
		if err == nil {
			return client, nil
		}
		lastErr = err

		select {
		case <-ctx.Done():
			if lastErr != nil {
				return nil, lastErr
			}
			return nil, ctx.Err()
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func resolveAgentCommand() (string, []string, error) {
	currentExecutable, err := os.Executable()
	if err != nil {
		return "", nil, err
	}
	currentExecutable, _ = filepath.EvalSymlinks(currentExecutable)
	currentDir := filepath.Dir(currentExecutable)

	agentName := "synapse-relay-agent"
	if runtimeExecutableSuffix() != "" {
		agentName += runtimeExecutableSuffix()
	}
	candidate := filepath.Join(currentDir, agentName)
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate, nil, nil
	}

	return currentExecutable, []string{"--relay-agent"}, nil
}

func randomToken() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func (a *App) ensureAgent() error {
	a.agentMu.Lock()
	defer a.agentMu.Unlock()

	if a.agent != nil && a.agent.client != nil {
		return nil
	}

	session, err := spawnStandaloneAgent(Version, a.profilePaths)
	if err != nil {
		return err
	}
	session.client.OnRelayEvent(a.handleAgentRelayEvent)
	a.agent = session
	return nil
}

func (a *App) closeAgent() {
	a.agentMu.Lock()
	session := a.agent
	a.agent = nil
	a.agentMu.Unlock()

	if session == nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if session.client != nil {
		_ = session.client.Quit(ctx)
		_ = session.client.Close()
	}
	if session.cmd != nil && session.cmd.Process != nil {
		done := make(chan struct{})
		go func() {
			_, _ = session.cmd.Process.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			_ = session.cmd.Process.Kill()
		}
	}
}

func (a *App) agentClient() (*relayagent.Client, error) {
	if err := a.ensureAgent(); err != nil {
		return nil, err
	}

	a.agentMu.Lock()
	defer a.agentMu.Unlock()
	if a.agent == nil || a.agent.client == nil {
		return nil, fmt.Errorf("relay agent is not available")
	}
	return a.agent.client, nil
}

func (a *App) handleAgentRelayEvent(evt relay.Event) {
	entry := LogEntry{
		Time:    evt.Timestamp.Format("15:04:05"),
		Type:    string(evt.Type),
		Message: evt.Message,
		Data:    evt.Data,
	}

	a.logsMu.Lock()
	a.logs = append(a.logs, entry)
	if len(a.logs) > 500 {
		a.logs = a.logs[len(a.logs)-500:]
	}
	a.logsMu.Unlock()

	if a.ctx != nil {
		wailsRuntime.EventsEmit(a.ctx, "relay:event", map[string]interface{}{
			"type":    entry.Type,
			"message": entry.Message,
			"time":    entry.Time,
			"data":    entry.Data,
		})
	}
	a.maybeNotifyBackgroundEvent(relay.Event{
		Type:      evt.Type,
		Message:   evt.Message,
		Timestamp: evt.Timestamp,
		Data:      evt.Data,
	})
}

func (a *App) agentContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), agentCallTimeout)
}

func runtimeExecutableSuffix() string {
	if strings.EqualFold(filepath.Ext(os.Args[0]), ".exe") {
		return ".exe"
	}
	return ""
}

func (a *App) loadLogsFromAgent() {
	client, err := a.agentClient()
	if err != nil {
		return
	}
	ctx, cancel := a.agentContext()
	defer cancel()

	logs, err := client.GetRecentLogs(ctx, 200)
	if err != nil {
		return
	}

	converted := make([]LogEntry, 0, len(logs))
	for _, entry := range logs {
		converted = append(converted, LogEntry{
			Time:    entry.Time,
			Type:    entry.Type,
			Message: entry.Message,
			Data:    entry.Data,
		})
	}

	a.logsMu.Lock()
	a.logs = append([]LogEntry(nil), converted...)
	a.logsMu.Unlock()
}

func (a *App) fetchRemoteStatus(includeServers bool) (StatusInfo, error) {
	client, err := a.agentClient()
	if err != nil {
		return StatusInfo{State: "stopped"}, err
	}
	ctx, cancel := a.agentContext()
	defer cancel()

	status, err := client.GetStatus(ctx, includeServers)
	if err != nil {
		return StatusInfo{State: "stopped"}, err
	}
	return StatusInfo{
		State:                status.State,
		Error:                status.Error,
		AuthFailureCode:      status.AuthFailureCode,
		AuthFailureMessage:   status.AuthFailureMessage,
		AuthFailurePermanent: status.AuthFailurePermanent,
		Servers:              status.Servers,
	}, nil
}

func (a *App) applyConfigToAgent(cfg *config.Config) (*relaycontroller.ApplyConfigResult, error) {
	client, err := a.agentClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.agentContext()
	defer cancel()
	return client.ApplyConfig(ctx, cfg)
}

func (a *App) claimPairingWithAgent(serverBaseURL, pairingCode, displayName string) (*cloud.PairingClaimResult, error) {
	client, err := a.agentClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.agentContext()
	defer cancel()
	return client.ClaimPairing(ctx, serverBaseURL, pairingCode, displayName)
}

func (a *App) startRelayWithAgent() error {
	client, err := a.agentClient()
	if err != nil {
		return err
	}
	ctx, cancel := a.agentContext()
	defer cancel()
	return client.StartRelay(ctx)
}

func (a *App) stopRelayWithAgent() error {
	client, err := a.agentClient()
	if err != nil {
		return err
	}
	ctx, cancel := a.agentContext()
	defer cancel()
	return client.StopRelay(ctx)
}

func (a *App) restartRelayWithAgent() error {
	client, err := a.agentClient()
	if err != nil {
		return err
	}
	ctx, cancel := a.agentContext()
	defer cancel()
	return client.RestartRelay(ctx)
}
