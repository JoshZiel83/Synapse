package relaycontroller

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/cloud"
	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/mcp"
	"github.com/PekingSpades/Synapse/relay/internal/relay"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
	"github.com/PekingSpades/Synapse/relay/internal/vfs"
)

type StatusInfo struct {
	State                string           `json:"state"`
	Error                string           `json:"error,omitempty"`
	AuthFailureCode      string           `json:"authFailureCode,omitempty"`
	AuthFailureMessage   string           `json:"authFailureMessage,omitempty"`
	AuthFailurePermanent bool             `json:"authFailurePermanent,omitempty"`
	Servers              []mcp.ServerInfo `json:"servers,omitempty"`
}

type LogEntry struct {
	Time    string                 `json:"time"`
	Type    string                 `json:"type"`
	Message string                 `json:"message"`
	Data    map[string]interface{} `json:"data,omitempty"`
}

type ApplyConfigResult struct {
	Message     string `json:"message,omitempty"`
	AutoApplied bool   `json:"autoApplied,omitempty"`
}

type EventListener func(relay.Event)

type Controller struct {
	paths   relaypaths.ResolvedPaths
	version string

	cfgMu sync.RWMutex
	cfg   *config.Config

	engineMu sync.RWMutex
	engine   *relay.Engine

	vfsMu      sync.Mutex
	vfsService *vfs.Service

	authFailureMu        sync.RWMutex
	authFailureCode      string
	authFailureMessage   string
	authFailurePermanent bool

	logsMu sync.Mutex
	logs   []LogEntry

	listenersMu sync.RWMutex
	listeners   []EventListener
}

func New(paths relaypaths.ResolvedPaths, version string) (*Controller, error) {
	relaypaths.SetCurrent(paths)
	if err := relaypaths.Ensure(paths); err != nil {
		return nil, err
	}

	cfg, err := config.Load(paths.ConfigPath)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		cfg, err = config.LoadOrDefault("")
		if err != nil {
			return nil, err
		}
	}

	return &Controller{
		paths:   paths,
		version: version,
		cfg:     config.Clone(cfg),
		logs:    make([]LogEntry, 0, 64),
	}, nil
}

func (c *Controller) Paths() relaypaths.ResolvedPaths {
	return c.paths
}

func (c *Controller) OnEvent(listener EventListener) {
	c.listenersMu.Lock()
	c.listeners = append(c.listeners, listener)
	c.listenersMu.Unlock()
}

func (c *Controller) emit(evt relay.Event) {
	evt = sanitizeRelayEvent(evt)
	entry := LogEntry{
		Time:    evt.Timestamp.Format("15:04:05"),
		Type:    string(evt.Type),
		Message: evt.Message,
		Data:    evt.Data,
	}

	c.logsMu.Lock()
	c.logs = append(c.logs, entry)
	if len(c.logs) > 500 {
		c.logs = c.logs[len(c.logs)-500:]
	}
	c.logsMu.Unlock()

	c.listenersMu.RLock()
	listeners := make([]EventListener, len(c.listeners))
	copy(listeners, c.listeners)
	c.listenersMu.RUnlock()

	for _, listener := range listeners {
		listener(evt)
	}
}

func (c *Controller) GetConfig() *config.Config {
	c.cfgMu.RLock()
	defer c.cfgMu.RUnlock()
	return config.Clone(c.cfg)
}

func (c *Controller) ApplyConfig(cfg *config.Config) (ApplyConfigResult, error) {
	if cfg == nil {
		return ApplyConfigResult{}, fmt.Errorf("config is required")
	}
	relaypaths.SetCurrent(c.paths)
	if err := relaypaths.Ensure(c.paths); err != nil {
		return ApplyConfigResult{}, err
	}
	if err := config.Save(c.paths.ConfigPath, cfg); err != nil {
		return ApplyConfigResult{}, err
	}

	c.cfgMu.Lock()
	c.cfg = config.Clone(cfg)
	c.cfgMu.Unlock()

	c.vfsMu.Lock()
	if c.vfsService != nil {
		c.vfsService.Close()
		c.vfsService = nil
	}
	c.vfsMu.Unlock()

	engine := c.currentEngine()
	if engine != nil {
		engine.UpdateConfig(config.Clone(cfg))
	}

	message, autoApplied := c.applyConfigToRunningRelay(cfg)
	return ApplyConfigResult{
		Message:     message,
		AutoApplied: autoApplied,
	}, nil
}

func (c *Controller) ClaimPairing(serverBaseURL, pairingCode, displayName string) (*cloud.PairingClaimResult, error) {
	relaypaths.SetCurrent(c.paths)
	cfg := c.GetConfig()
	cfg.Relay.ServerBaseURL = strings.TrimSpace(serverBaseURL)
	if strings.TrimSpace(displayName) != "" {
		cfg.Relay.DisplayName = strings.TrimSpace(displayName)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	nextRelay, result, err := cloud.ClaimPairing(ctx, cfg.Relay, pairingCode, displayName)
	if err != nil {
		return nil, err
	}

	cfg.Relay = *nextRelay
	if _, err := c.ApplyConfig(cfg); err != nil {
		return nil, err
	}

	c.emit(relay.NewEvent(relay.EventLog, fmt.Sprintf("Paired device %s to %s", result.DeviceID, result.ServerBaseURL)))
	return result, nil
}

func (c *Controller) StartRelay() error {
	relaypaths.SetCurrent(c.paths)
	current := c.currentEngine()
	if current != nil {
		state := current.State()
		if state == relay.StateRunning || state == relay.StateStarting {
			return fmt.Errorf("relay already running")
		}
	}

	cfg := c.GetConfig()
	if errs := config.Validate(cfg); len(errs) > 0 {
		return fmt.Errorf("config invalid: %s", errs[0])
	}

	engine := relay.New(cfg)
	engine.SetClientVersion(c.version)
	engine.OnEvent(c.handleRelayEvent)

	c.clearAuthFailure()

	c.engineMu.Lock()
	c.engine = engine
	c.engineMu.Unlock()

	return engine.Start(context.Background())
}

func (c *Controller) StopRelay() error {
	engine := c.currentEngine()
	if engine == nil {
		return fmt.Errorf("relay not running")
	}
	return engine.Stop()
}

func (c *Controller) RestartRelay() error {
	engine := c.currentEngine()
	if engine != nil && (engine.State() == relay.StateRunning || engine.State() == relay.StateStarting) {
		if err := engine.Stop(); err != nil {
			return err
		}
	}
	return c.StartRelay()
}

func (c *Controller) Shutdown() error {
	c.vfsMu.Lock()
	if c.vfsService != nil {
		c.vfsService.Close()
		c.vfsService = nil
	}
	c.vfsMu.Unlock()

	engine := c.currentEngine()
	if engine == nil {
		return nil
	}
	state := engine.State()
	if state != relay.StateRunning && state != relay.StateStarting {
		return nil
	}
	return engine.Stop()
}

func (c *Controller) GetStatus(includeServers bool) StatusInfo {
	info := StatusInfo{State: "stopped"}
	engine := c.currentEngine()
	if engine != nil {
		info.State = string(engine.State())
		if err := engine.LastError(); err != nil {
			info.Error = err.Error()
		}
		if includeServers {
			info.Servers = engine.ServerInfo()
		}
	}

	c.authFailureMu.RLock()
	info.AuthFailureCode = c.authFailureCode
	info.AuthFailureMessage = c.authFailureMessage
	info.AuthFailurePermanent = c.authFailurePermanent
	c.authFailureMu.RUnlock()

	return info
}

func (c *Controller) GetRecentLogs(count int) []LogEntry {
	c.logsMu.Lock()
	defer c.logsMu.Unlock()

	if count <= 0 || count > len(c.logs) {
		count = len(c.logs)
	}
	start := len(c.logs) - count
	if start < 0 {
		start = 0
	}
	result := make([]LogEntry, count)
	copy(result, c.logs[start:])
	return result
}

func (c *Controller) applyConfigToRunningRelay(cfg *config.Config) (string, bool) {
	engine := c.currentEngine()
	if engine == nil {
		return "", false
	}

	state := engine.State()
	if state != relay.StateRunning && state != relay.StateStarting {
		return "", false
	}

	cfgCopy := config.Clone(cfg)
	if errs := config.Validate(cfgCopy); len(errs) > 0 {
		return fmt.Sprintf("Configuration updated, but relay kept the previous runtime settings: %s", errs[0]), false
	}

	if err := c.RestartRelay(); err != nil {
		return fmt.Sprintf("Configuration updated, but relay restart failed: %v", err), false
	}
	return "Configuration applied and relay restarted.", true
}

func (c *Controller) handleRelayEvent(evt relay.Event) {
	switch evt.Type {
	case relay.EventAuthFailed:
		c.setAuthFailure(
			stringMetadata(evt.Data, "code"),
			evt.Message,
			boolMetadata(evt.Data, "permanent"),
		)
	case relay.EventConnected:
		c.clearAuthFailure()
	}
	c.emit(evt)
}

func (c *Controller) currentEngine() *relay.Engine {
	c.engineMu.RLock()
	defer c.engineMu.RUnlock()
	return c.engine
}

func (c *Controller) VFSList(pathValue string) ([]vfs.Entry, error) {
	service, err := c.getVFSService()
	if err != nil {
		return nil, err
	}
	return service.List(pathValue)
}

func (c *Controller) VFSStat(pathValue string) (vfs.Entry, error) {
	service, err := c.getVFSService()
	if err != nil {
		return vfs.Entry{}, err
	}
	return service.Stat(pathValue)
}

func (c *Controller) VFSRead(pathValue string) (vfs.ReadResult, error) {
	service, err := c.getVFSService()
	if err != nil {
		return vfs.ReadResult{}, err
	}
	return service.Read(pathValue)
}

func (c *Controller) VFSWrite(pathValue string, data []byte) (vfs.WriteResult, error) {
	service, err := c.getVFSService()
	if err != nil {
		return vfs.WriteResult{}, err
	}
	return service.Write(pathValue, data)
}

func (c *Controller) getVFSService() (*vfs.Service, error) {
	c.vfsMu.Lock()
	defer c.vfsMu.Unlock()

	if c.vfsService != nil {
		return c.vfsService, nil
	}

	relaypaths.SetCurrent(c.paths)
	service, err := vfs.New(c.paths, c.GetConfig())
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if err := service.Start(ctx); err != nil {
		service.Close()
		return nil, err
	}
	c.vfsService = service
	return c.vfsService, nil
}

func (c *Controller) setAuthFailure(code, message string, permanent bool) {
	c.authFailureMu.Lock()
	c.authFailureCode = code
	c.authFailureMessage = message
	c.authFailurePermanent = permanent
	c.authFailureMu.Unlock()
}

func (c *Controller) clearAuthFailure() {
	c.setAuthFailure("", "", false)
}

func stringMetadata(input map[string]interface{}, key string) string {
	if input == nil {
		return ""
	}
	return fmt.Sprintf("%v", input[key])
}

func boolMetadata(input map[string]interface{}, key string) bool {
	if input == nil {
		return false
	}
	value, ok := input[key].(bool)
	return ok && value
}
