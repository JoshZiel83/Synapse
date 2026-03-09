package main

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/importer"
	"github.com/PekingSpades/Synapse/relay/internal/mcp"
	"github.com/PekingSpades/Synapse/relay/internal/relay"
	"github.com/gorilla/websocket"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// StatusInfo is returned by GetStatus for the dashboard
type StatusInfo struct {
	State   string           `json:"state"`
	Error   string           `json:"error,omitempty"`
	Servers []mcp.ServerInfo `json:"servers,omitempty"`
}

// LogEntry represents a log line for the GUI
type LogEntry struct {
	Time    string `json:"time"`
	Type    string `json:"type"`
	Message string `json:"message"`
}

// App is the Wails-bound application struct
type App struct {
	ctx     context.Context
	engine  *relay.Engine
	cfg     *config.Config
	cfgPath string
	logs    []LogEntry
	logsMu  sync.Mutex
}

// NewApp creates a new App instance
func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	// Load config
	cfgPath := config.Resolve("")
	if cfgPath == "" {
		cfgPath = config.DefaultPath()
	}
	a.cfgPath = cfgPath

	cfg, err := config.LoadOrDefault(cfgPath)
	if err != nil {
		cfg = &config.Config{LogLevel: "info"}
	}
	a.cfg = cfg
}

func (a *App) shutdown(ctx context.Context) {
	if a.engine != nil && (a.engine.State() == relay.StateRunning || a.engine.State() == relay.StateStarting) {
		a.engine.Stop()
	}
}

// --- Config methods ---

func (a *App) GetConfig() *config.Config {
	return a.cfg
}

func (a *App) SaveConfig(cfg config.Config) error {
	a.cfg = &cfg
	if err := config.EnsureDir(); err != nil {
		return err
	}
	return config.Save(a.cfgPath, &cfg)
}

func (a *App) TestConnection(endpoint, token string) (string, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.Dial(endpoint, http.Header{})
	if err != nil {
		return "", fmt.Errorf("connection failed: %w", err)
	}
	defer conn.Close()

	// Send auth
	authMsg := map[string]string{"type": "auth", "token": token}
	if err := conn.WriteJSON(authMsg); err != nil {
		return "", fmt.Errorf("auth send failed: %w", err)
	}

	// Read response
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var resp map[string]interface{}
	if err := conn.ReadJSON(&resp); err != nil {
		return "", fmt.Errorf("auth response failed: %w", err)
	}

	if resp["type"] == "auth_error" {
		msg, _ := resp["message"].(string)
		return "", fmt.Errorf("auth rejected: %s", msg)
	}

	if resp["type"] == "auth_ok" {
		relayID, _ := resp["relayId"].(string)
		return fmt.Sprintf("Connected! Relay ID: %s", relayID), nil
	}

	return fmt.Sprintf("Unexpected response: %v", resp["type"]), nil
}

// --- Relay control methods ---

func (a *App) StartRelay() error {
	if a.engine != nil && a.engine.State() == relay.StateRunning {
		return fmt.Errorf("relay already running")
	}

	errs := config.Validate(a.cfg)
	if len(errs) > 0 {
		return fmt.Errorf("config invalid: %s", errs[0])
	}

	a.engine = relay.New(a.cfg)
	a.engine.OnEvent(func(evt relay.Event) {
		// Store log
		a.logsMu.Lock()
		a.logs = append(a.logs, LogEntry{
			Time:    evt.Timestamp.Format("15:04:05"),
			Type:    string(evt.Type),
			Message: evt.Message,
		})
		if len(a.logs) > 500 {
			a.logs = a.logs[len(a.logs)-500:]
		}
		a.logsMu.Unlock()

		// Emit to frontend
		wailsRuntime.EventsEmit(a.ctx, "relay:event", map[string]interface{}{
			"type":    evt.Type,
			"message": evt.Message,
			"time":    evt.Timestamp.Format("15:04:05"),
			"data":    evt.Data,
		})
	})

	return a.engine.Start(context.Background())
}

func (a *App) StopRelay() error {
	if a.engine == nil {
		return fmt.Errorf("relay not running")
	}
	return a.engine.Stop()
}

func (a *App) RestartRelay() error {
	if a.engine != nil && (a.engine.State() == relay.StateRunning || a.engine.State() == relay.StateStarting) {
		if err := a.engine.Stop(); err != nil {
			return err
		}
	}
	return a.StartRelay()
}

func (a *App) GetStatus() StatusInfo {
	info := StatusInfo{State: "stopped"}
	if a.engine != nil {
		info.State = string(a.engine.State())
		if err := a.engine.LastError(); err != nil {
			info.Error = err.Error()
		}
		info.Servers = a.engine.ServerInfo()
	}
	return info
}

// --- Server management ---

func (a *App) AddServer(sc config.ServerConfig) error {
	for _, s := range a.cfg.Servers {
		if s.Name == sc.Name {
			return fmt.Errorf("server %q already exists", sc.Name)
		}
	}
	a.cfg.Servers = append(a.cfg.Servers, sc)
	return config.Save(a.cfgPath, a.cfg)
}

func (a *App) RemoveServer(name string) error {
	for i, s := range a.cfg.Servers {
		if s.Name == name {
			a.cfg.Servers = append(a.cfg.Servers[:i], a.cfg.Servers[i+1:]...)
			return config.Save(a.cfgPath, a.cfg)
		}
	}
	return fmt.Errorf("server %q not found", name)
}

// --- Import ---

func (a *App) DetectSources() []importer.Source {
	return importer.DetectAll()
}

func (a *App) ImportServers(servers []importer.ImportedServer) error {
	existingNames := make(map[string]bool)
	for _, s := range a.cfg.Servers {
		existingNames[s.Name] = true
	}

	configs := importer.ToServerConfigs(servers)
	added := 0
	for _, sc := range configs {
		if !existingNames[sc.Name] {
			a.cfg.Servers = append(a.cfg.Servers, sc)
			existingNames[sc.Name] = true
			added++
		}
	}

	if added == 0 {
		return fmt.Errorf("all selected servers already exist in config")
	}

	return config.Save(a.cfgPath, a.cfg)
}

// --- Logs ---

func (a *App) GetRecentLogs(count int) []LogEntry {
	a.logsMu.Lock()
	defer a.logsMu.Unlock()

	if count <= 0 || count > len(a.logs) {
		count = len(a.logs)
	}
	start := len(a.logs) - count
	if start < 0 {
		start = 0
	}
	result := make([]LogEntry, count)
	copy(result, a.logs[start:])
	return result
}
