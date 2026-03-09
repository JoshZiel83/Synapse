package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/importer"
	"github.com/PekingSpades/Synapse/relay/internal/localapi"
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

// GUISource represents a detected MCP config source (main-package mirror of importer.Source
// to avoid Wails v2 cross-package binding issues on Windows WebView2)
type GUISource struct {
	Name       string            `json:"name"`
	ConfigPath string            `json:"configPath"`
	Available  bool              `json:"available"`
	Servers    []GUIImportServer `json:"servers"`
	Error      string            `json:"error,omitempty"`
}

// GUIImportServer is a main-package mirror of importer.ImportedServer
type GUIImportServer struct {
	Name      string            `json:"name"`
	Transport string            `json:"transport"`
	Command   string            `json:"command,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Endpoint  string            `json:"endpoint,omitempty"`
}

// App is the Wails-bound application struct
type App struct {
	ctx      context.Context
	engine   *relay.Engine
	cfg      *config.Config
	cfgPath  string
	logs     []LogEntry
	logsMu   sync.Mutex
	localAPI *localapi.Server
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

	// Start local API server for web-to-client communication
	a.localAPI = localapi.New(localapi.DefaultPort, Version, a.handleRemoteSetup, a.getRelayState)
	if err := a.localAPI.Start(); err != nil {
		log.Printf("Warning: failed to start local API: %v", err)
	}

	// Check for deep link URL in args (synapse-relay://setup?endpoint=...&token=...)
	a.handleDeepLinkArgs()
}

func (a *App) shutdown(ctx context.Context) {
	if a.localAPI != nil {
		a.localAPI.Stop()
	}
	if a.engine != nil && (a.engine.State() == relay.StateRunning || a.engine.State() == relay.StateStarting) {
		a.engine.Stop()
	}
}

// handleRemoteSetup is called by the local API when the web UI sends a setup request.
// Shows a confirmation dialog and returns true if the user accepts.
func (a *App) handleRemoteSetup(endpoint, token string) bool {
	// Show confirmation dialog via Wails runtime
	// Note: QuestionDialog returns platform-specific strings:
	//   Windows: "Yes"/"No", macOS/Linux: custom button label
	result, err := wailsRuntime.MessageDialog(a.ctx, wailsRuntime.MessageDialogOptions{
		Type:    wailsRuntime.QuestionDialog,
		Title:   "Remote Configuration",
		Message: fmt.Sprintf("The web dashboard wants to configure this relay:\n\nEndpoint: %s\nToken: %s...%s\n\nAccept this configuration?", endpoint, token[:8], token[len(token)-4:]),
		Buttons: []string{"Accept", "Reject"},
	})
	if err != nil {
		log.Printf("Dialog error: %v", err)
		return false
	}

	accepted := result == "Accept" || result == "Yes" || result == "Ok"
	if accepted {
		a.cfg.Endpoint = endpoint
		a.cfg.Token = token
		if err := config.EnsureDir(); err == nil {
			config.Save(a.cfgPath, a.cfg)
		}
		// Emit event to frontend to update UI
		wailsRuntime.EventsEmit(a.ctx, "config:updated", map[string]interface{}{
			"endpoint": endpoint,
		})
		return true
	}
	return false
}

func (a *App) getRelayState() string {
	if a.engine != nil {
		return string(a.engine.State())
	}
	return "stopped"
}

// handleDeepLinkArgs checks os.Args for a synapse-relay:// URL and processes it.
func (a *App) handleDeepLinkArgs() {
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "synapse-relay://") {
			a.processDeepLink(arg)
			return
		}
	}
}

// processDeepLink parses synapse-relay://setup?endpoint=...&token=... and triggers setup.
func (a *App) processDeepLink(rawURL string) {
	u, err := url.Parse(rawURL)
	if err != nil {
		log.Printf("Failed to parse deep link: %v", err)
		return
	}

	if u.Host == "setup" || u.Path == "setup" || u.Path == "/setup" {
		endpoint := u.Query().Get("endpoint")
		token := u.Query().Get("token")
		if endpoint != "" && token != "" {
			// Defer to after startup completes (ctx must be ready)
			go func() {
				time.Sleep(500 * time.Millisecond) // wait for window to render
				a.handleRemoteSetup(endpoint, token)
			}()
		}
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

func (a *App) DetectSources() []GUISource {
	sources := importer.DetectAll()
	result := make([]GUISource, len(sources))
	for i, s := range sources {
		gs := GUISource{
			Name:       s.Name,
			ConfigPath: s.ConfigPath,
			Available:  s.Available,
			Error:      s.Error,
			Servers:    make([]GUIImportServer, len(s.Servers)),
		}
		for j, srv := range s.Servers {
			gs.Servers[j] = GUIImportServer{
				Name:      srv.Name,
				Transport: srv.Transport,
				Command:   srv.Command,
				Args:      srv.Args,
				Env:       srv.Env,
				Endpoint:  srv.Endpoint,
			}
		}
		result[i] = gs
	}
	return result
}

func (a *App) ImportServers(servers []GUIImportServer) error {
	existingNames := make(map[string]bool)
	for _, s := range a.cfg.Servers {
		existingNames[s.Name] = true
	}

	added := 0
	for _, srv := range servers {
		if existingNames[srv.Name] {
			continue
		}
		sc := config.ServerConfig{
			Name:      srv.Name,
			Transport: srv.Transport,
			Command:   srv.Command,
			Args:      srv.Args,
			Env:       srv.Env,
			Endpoint:  srv.Endpoint,
		}
		if sc.Transport == "" {
			sc.Transport = "stdio"
		}
		a.cfg.Servers = append(a.cfg.Servers, sc)
		existingNames[srv.Name] = true
		added++
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
