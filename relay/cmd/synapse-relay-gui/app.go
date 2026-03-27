package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/cloud"
	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/importer"
	"github.com/PekingSpades/Synapse/relay/internal/localapi"
	"github.com/PekingSpades/Synapse/relay/internal/mcp"
	"github.com/PekingSpades/Synapse/relay/internal/relay"
	"github.com/PekingSpades/Synapse/relay/internal/startup"
	"github.com/PekingSpades/Synapse/relay/internal/tray"
	"github.com/adrg/xdg"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// StatusInfo is returned by GetStatus for the dashboard
type StatusInfo struct {
	State                string           `json:"state"`
	Error                string           `json:"error,omitempty"`
	AuthFailureCode      string           `json:"authFailureCode,omitempty"`
	AuthFailureMessage   string           `json:"authFailureMessage,omitempty"`
	AuthFailurePermanent bool             `json:"authFailurePermanent,omitempty"`
	Servers              []mcp.ServerInfo `json:"servers,omitempty"`
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
	Kind       string            `json:"kind"`
	SourceKey  string            `json:"sourceKey"`
	Name       string            `json:"name"`
	ConfigPath string            `json:"configPath"`
	Available  bool              `json:"available"`
	SyncMode   string            `json:"syncMode,omitempty"`
	Status     string            `json:"status,omitempty"`
	LinkedMCPs int               `json:"linkedMcps,omitempty"`
	Servers    []GUIImportServer `json:"servers"`
	Error      string            `json:"error,omitempty"`
}

// GUIImportServer is a main-package mirror of importer.ImportedServer
type GUIImportServer struct {
	SourceKind       string            `json:"sourceKind,omitempty"`
	SourceKey        string            `json:"sourceKey,omitempty"`
	SourceConfigPath string            `json:"sourceConfigPath,omitempty"`
	Name             string            `json:"name"`
	Transport        string            `json:"transport"`
	Command          string            `json:"command,omitempty"`
	Args             []string          `json:"args,omitempty"`
	Env              map[string]string `json:"env,omitempty"`
	Endpoint         string            `json:"endpoint,omitempty"`
}

// App is the Wails-bound application struct
type App struct {
	ctx                  context.Context
	engine               *relay.Engine
	cfg                  *config.Config
	cfgPath              string
	cfgHash              string
	cfgMu                sync.RWMutex
	updateMu             sync.Mutex
	logs                 []LogEntry
	logsMu               sync.Mutex
	authFailureMu        sync.RWMutex
	authFailureCode      string
	authFailureMessage   string
	authFailurePermanent bool
	localAPI             *localapi.Server
	watchCfgCancel       context.CancelFunc
	tray                 tray.Manager
	windowStateMu        sync.RWMutex
	windowHidden         bool
	allowQuit            bool
	launchedAtLogin      bool
}

// NewApp creates a new App instance
func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.launchedAtLogin = hasLaunchAtLoginArg(os.Args[1:])

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
	if importer.ReconcileConfig(cfg, importer.DetectAll()) {
		if err := a.persistConfigSilently(cfg); err != nil {
			log.Printf("Warning: failed to persist follow sync updates: %v", err)
		}
	}
	if changed, syncErr := a.syncStartupStateFromSystem(cfg); syncErr != nil {
		log.Printf("Warning: failed to read startup preference: %v", syncErr)
	} else if changed {
		if err := a.persistConfigSilently(cfg); err != nil {
			log.Printf("Warning: failed to persist startup preference: %v", err)
		}
	}
	a.cfg = config.Clone(cfg)
	a.cfgHash = config.Fingerprint(a.cfg)
	a.setWindowHidden(a.launchedAtLogin && a.cfg.Startup.LaunchHidden)

	watchCtx, cancel := context.WithCancel(context.Background())
	a.watchCfgCancel = cancel
	go config.NewWatcher(a.cfgPath, 1500*time.Millisecond, a.handleConfigWatchEvent).Start(watchCtx)

	// Start local API server for web-to-client communication
	a.localAPI = localapi.New(localapi.DefaultPort, Version, a.handleRemotePairing, a.getLocalStatus)
	if err := a.localAPI.Start(); err != nil {
		log.Printf("Warning: failed to start local API: %v", err)
	}

	if err := a.syncStartupPreference(a.cfg); err != nil {
		log.Printf("Warning: failed to sync startup preference: %v", err)
	}
	if err := a.initialiseTray(); err != nil {
		log.Printf("Warning: failed to initialise tray: %v", err)
	}

	// Check for deep link URL in args (synapse-relay://pair?serverBaseUrl=...&code=...)
	a.handleDeepLinkArgs()

	if a.cfg.Startup.AutoConnect {
		go a.autoConnectAfterLaunch()
	}
}

func (a *App) domReady(ctx context.Context) {
	if !a.isWindowHidden() {
		return
	}
	if a.tray == nil || !a.tray.Available() {
		wailsRuntime.WindowShow(ctx)
		a.setWindowHidden(false)
	}
}

func (a *App) shutdown(ctx context.Context) {
	if a.watchCfgCancel != nil {
		a.watchCfgCancel()
	}
	if a.localAPI != nil {
		a.localAPI.Stop()
	}
	if a.engine != nil && (a.engine.State() == relay.StateRunning || a.engine.State() == relay.StateStarting) {
		a.engine.Stop()
	}
	if a.tray != nil {
		_ = a.tray.Close()
	}
}

func (a *App) beforeClose(ctx context.Context) bool {
	if a.shouldAllowQuit() {
		return false
	}
	if a.engine == nil || a.engine.State() != relay.StateRunning {
		return false
	}
	if a.tray == nil || !a.tray.Available() {
		return false
	}

	closeBehavior := config.CloseBehaviorAsk
	if cfg := a.getConfigSnapshot(); cfg != nil {
		closeBehavior = normalizeCloseBehavior(cfg.Startup.CloseBehavior)
	}

	switch closeBehavior {
	case config.CloseBehaviorQuit:
		a.setAllowQuit(true)
		return false
	case config.CloseBehaviorAsk:
		if a.ctx != nil {
			wailsRuntime.EventsEmit(a.ctx, "window:confirm-close")
			return true
		}
		fallthrough
	default:
		a.hideWindowToTray(ctx)
		return true
	}
}

// handleRemotePairing is called by the local API when the web UI sends a pairing request.
// Shows a confirmation dialog and, if accepted, claims the pairing and persists the relay identity.
func (a *App) handleRemotePairing(serverBaseURL, pairingCode, displayName string) bool {
	result, err := wailsRuntime.MessageDialog(a.ctx, wailsRuntime.MessageDialogOptions{
		Type:    wailsRuntime.QuestionDialog,
		Title:   "Relay Pairing Request",
		Message: fmt.Sprintf("The web dashboard wants to pair this relay client:\n\nServer: %s\nCode: %s\n\nAccept this pairing?", serverBaseURL, summarizeSecret(pairingCode)),
		Buttons: []string{"Accept", "Reject"},
	})
	if err != nil {
		log.Printf("Dialog error: %v", err)
		return false
	}

	accepted := result == "Accept" || result == "Yes" || result == "Ok"
	if accepted {
		if _, err := a.claimPairing(serverBaseURL, pairingCode, displayName); err != nil {
			_, _ = wailsRuntime.MessageDialog(a.ctx, wailsRuntime.MessageDialogOptions{
				Type:    wailsRuntime.ErrorDialog,
				Title:   "Pairing Failed",
				Message: err.Error(),
			})
			return false
		}
		return true
	}
	return false
}

func (a *App) getLocalStatus() localapi.StatusSnapshot {
	cfg := a.getConfigSnapshot()
	state := "stopped"
	if a.engine != nil {
		state = string(a.engine.State())
	}

	return localapi.StatusSnapshot{
		Relay:                 state,
		Paired:                strings.TrimSpace(cfg.Relay.DeviceID) != "",
		ServerIdentityPinned:  strings.TrimSpace(cfg.Relay.ServerTLSPublicKeyPin) != "",
		AuthFailureCode:       a.getAuthFailureCode(),
		AuthFailureMessage:    a.getAuthFailureMessage(),
		AuthFailurePermanent:  a.getAuthFailurePermanent(),
		DeviceID:              cfg.Relay.DeviceID,
		DisplayName:           cfg.Relay.DisplayName,
		ServerBaseURL:         cfg.Relay.ServerBaseURL,
		WebSocketURL:          cfg.Relay.WebSocketURL,
		PublicKeyFingerprint:  cfg.Relay.PublicKeyFingerprint,
		ServerTLSPublicKeyPin: cfg.Relay.ServerTLSPublicKeyPin,
	}
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

// processDeepLink parses synapse-relay://pair?serverBaseUrl=...&code=... and triggers pairing.
func (a *App) processDeepLink(rawURL string) {
	u, err := url.Parse(rawURL)
	if err != nil {
		log.Printf("Failed to parse deep link: %v", err)
		return
	}

	if u.Host == "pair" || u.Path == "pair" || u.Path == "/pair" {
		serverBaseURL := u.Query().Get("serverBaseUrl")
		pairingCode := u.Query().Get("code")
		displayName := u.Query().Get("displayName")
		if serverBaseURL != "" && pairingCode != "" {
			// Defer to after startup completes (ctx must be ready)
			go func() {
				time.Sleep(500 * time.Millisecond) // wait for window to render
				a.handleRemotePairing(serverBaseURL, pairingCode, displayName)
			}()
		}
	}
}

// --- Config methods ---

func (a *App) GetConfig() *config.Config {
	return a.getConfigSnapshot()
}

func (a *App) SaveConfig(cfg config.Config) error {
	a.setConfig(&cfg)
	message, autoApplied, err := a.persistConfig(&cfg)
	if err != nil {
		return err
	}
	a.emitConfigUpdated(&cfg, message, autoApplied)
	return nil
}

func (a *App) SaveDesktopPreferences(startupCfg config.StartupConfig, notificationCfg config.NotificationConfig) error {
	cfg := a.getConfigSnapshot()
	if cfg == nil {
		cfg = &config.Config{}
	}

	cfg.Startup = startupCfg
	cfg.Notifications = notificationCfg

	if err := config.EnsureDir(); err != nil {
		return err
	}
	if err := config.Save(a.cfgPath, cfg); err != nil {
		return err
	}
	if err := a.syncStartupPreference(cfg); err != nil {
		return err
	}

	a.setConfig(cfg)
	a.setConfigHash(config.Fingerprint(cfg))
	a.emitConfigUpdated(cfg, "Desktop settings updated.", false)
	return nil
}

func (a *App) ConfirmWindowClose(action string, remember bool) error {
	action = normalizeCloseAction(action)
	if action == closeActionCancel {
		return nil
	}

	if remember {
		if err := a.saveCloseBehaviorPreference(action); err != nil {
			return err
		}
	}

	switch action {
	case config.CloseBehaviorTray:
		a.hideWindowToTray(a.ctx)
	case config.CloseBehaviorQuit:
		a.setAllowQuit(true)
		wailsRuntime.Quit(a.ctx)
	}
	return nil
}

func (a *App) GetSuggestedFilesystemRoots() []config.BuiltinFilesystemRootConfig {
	xdg.Reload()
	return suggestedFilesystemRootsFromUserDirs(xdg.UserDirs.Download, xdg.UserDirs.Desktop)
}

func (a *App) ClaimPairing(serverBaseURL, pairingCode, displayName string) (string, error) {
	result, err := a.claimPairing(serverBaseURL, pairingCode, displayName)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Paired device %s to %s", result.DeviceID, result.ServerBaseURL), nil
}

func (a *App) claimPairing(serverBaseURL, pairingCode, displayName string) (*cloud.PairingClaimResult, error) {
	cfg := a.getConfigSnapshot()
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
	a.setConfig(cfg)

	message, autoApplied, err := a.persistConfig(cfg)
	if err != nil {
		return nil, err
	}

	a.emitConfigUpdated(cfg, message, autoApplied)
	go a.prefetchUpdateAfterPairing()
	return result, nil
}

func suggestedFilesystemRootsFromUserDirs(downloadDir, desktopDir string) []config.BuiltinFilesystemRootConfig {
	candidates := []string{
		strings.TrimSpace(downloadDir),
		strings.TrimSpace(desktopDir),
	}
	seen := make(map[string]struct{}, len(candidates))
	roots := make([]config.BuiltinFilesystemRootConfig, 0, len(candidates))

	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		cleaned := filepath.Clean(candidate)
		if _, ok := seen[cleaned]; ok {
			continue
		}
		info, err := os.Stat(cleaned)
		if err != nil || !info.IsDir() {
			continue
		}
		seen[cleaned] = struct{}{}
		roots = append(roots, config.BuiltinFilesystemRootConfig{
			Path:   cleaned,
			Access: "ro",
		})
	}

	return roots
}

// --- Relay control methods ---

func (a *App) StartRelay() error {
	if a.engine != nil && a.engine.State() == relay.StateRunning {
		return fmt.Errorf("relay already running")
	}

	cfg := a.getConfigSnapshot()
	if importer.ReconcileConfig(cfg, importer.DetectAll()) {
		if err := a.persistConfigSilently(cfg); err != nil {
			return err
		}
		a.emitConfigUpdated(cfg, "Follow sync sources updated from disk.", false)
	}
	errs := config.Validate(cfg)
	if len(errs) > 0 {
		return fmt.Errorf("config invalid: %s", errs[0])
	}

	a.engine = relay.New(cfg)
	a.engine.SetClientVersion(Version)
	a.engine.SetBeforeConnect(a.beforeRelayConnect)
	a.clearAuthFailure()
	a.engine.OnEvent(func(evt relay.Event) {
		switch evt.Type {
		case relay.EventAuthFailed:
			a.setAuthFailure(
				metadataString(evt.Data, "code"),
				evt.Message,
				metadataBool(evt.Data, "permanent"),
			)
		case relay.EventConnected:
			a.clearAuthFailure()
		}

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
		a.maybeNotifyBackgroundEvent(evt)
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
	return a.getStatusInfo(true)
}

func (a *App) GetStatusSummary() StatusInfo {
	return a.getStatusInfo(false)
}

func (a *App) getStatusInfo(includeServers bool) StatusInfo {
	info := StatusInfo{State: "stopped"}
	if a.engine != nil {
		info.State = string(a.engine.State())
		if err := a.engine.LastError(); err != nil {
			info.Error = err.Error()
		}
		info.AuthFailureCode = a.getAuthFailureCode()
		info.AuthFailureMessage = a.getAuthFailureMessage()
		info.AuthFailurePermanent = a.getAuthFailurePermanent()
		if includeServers {
			info.Servers = a.engine.ServerInfo()
		}
	}
	return info
}

// --- Server management ---

func (a *App) AddServer(sc config.ServerConfig) error {
	cfg := a.getConfigSnapshot()
	for _, s := range cfg.Servers {
		if s.Name == sc.Name {
			return fmt.Errorf("server %q already exists", sc.Name)
		}
	}
	cfg.Servers = append(cfg.Servers, sc)
	a.setConfig(cfg)
	message, autoApplied, err := a.persistConfig(cfg)
	if err != nil {
		return err
	}
	a.emitConfigUpdated(cfg, message, autoApplied)
	return nil
}

func (a *App) RemoveServer(name string) error {
	cfg := a.getConfigSnapshot()
	for i, s := range cfg.Servers {
		if s.Name == name {
			cfg.Servers = append(cfg.Servers[:i], cfg.Servers[i+1:]...)
			a.setConfig(cfg)
			message, autoApplied, err := a.persistConfig(cfg)
			if err != nil {
				return err
			}
			a.emitConfigUpdated(cfg, message, autoApplied)
			return nil
		}
	}
	return fmt.Errorf("server %q not found", name)
}

// --- Import ---

func (a *App) DetectSources() []GUISource {
	sources := importer.DetectAll()
	cfg := a.getConfigSnapshot()
	dirty := importer.ReconcileConfig(cfg, sources)
	bySourceKey := make(map[string]config.SyncSourceConfig, len(cfg.SyncSources))
	linkedServers := make(map[string]int)
	for _, source := range cfg.SyncSources {
		bySourceKey[source.SourceKey] = source
	}
	for _, server := range cfg.Servers {
		if server.SyncSourceKey != "" {
			linkedServers[server.SyncSourceKey]++
		}
	}

	result := make([]GUISource, len(sources))
	for i, s := range sources {
		existing := bySourceKey[s.SourceKey]
		gs := GUISource{
			Kind:       s.Kind,
			SourceKey:  s.SourceKey,
			Name:       s.Name,
			ConfigPath: s.ConfigPath,
			Available:  s.Available,
			SyncMode:   config.NormalizeSyncMode(existing.SyncMode),
			Status:     existing.Status,
			LinkedMCPs: linkedServers[s.SourceKey],
			Error:      s.Error,
			Servers:    make([]GUIImportServer, len(s.Servers)),
		}
		gs.Status = importer.SyncSourceStatus(s.Available, s.Error)
		for j, srv := range s.Servers {
			gs.Servers[j] = GUIImportServer{
				SourceKind:       srv.SourceKind,
				SourceKey:        srv.SourceKey,
				SourceConfigPath: srv.SourceConfigPath,
				Name:             srv.Name,
				Transport:        srv.Transport,
				Command:          srv.Command,
				Args:             srv.Args,
				Env:              srv.Env,
				Endpoint:         srv.Endpoint,
			}
		}

		result[i] = gs
	}

	if dirty {
		a.setConfig(cfg)
		if err := config.Save(a.cfgPath, cfg); err != nil {
			log.Printf("Warning: failed to persist sync source detection metadata: %v", err)
		} else {
			wailsRuntime.EventsEmit(a.ctx, "config:updated", config.Clone(cfg))
		}
	}
	return result
}

func (a *App) ImportServers(servers []GUIImportServer) error {
	cfg := a.getConfigSnapshot()
	existingNames := make(map[string]bool)
	for _, s := range cfg.Servers {
		existingNames[s.Name] = true
	}

	added := 0
	for _, srv := range servers {
		if existingNames[srv.Name] {
			continue
		}
		if srv.SourceKey != "" {
			syncSource := findSyncSourceConfig(cfg, srv.SourceKey)
			syncMode := config.SyncModeSnapshot
			if syncSource != nil && strings.TrimSpace(syncSource.SyncMode) != "" {
				syncMode = config.NormalizeSyncMode(syncSource.SyncMode)
			}
			upsertSyncSourceConfig(cfg, config.SyncSourceConfig{
				SourceKind: srv.SourceKind,
				SourceKey:  srv.SourceKey,
				ConfigPath: srv.SourceConfigPath,
				SyncMode:   syncMode,
				Status:     "idle",
				Metadata: map[string]interface{}{
					"displayName": srv.SourceKind,
				},
			})
		}
		sc := config.ServerConfig{
			SyncSourceKey: srv.SourceKey,
			Name:          srv.Name,
			Transport:     srv.Transport,
			Command:       srv.Command,
			Args:          srv.Args,
			Env:           srv.Env,
			Endpoint:      srv.Endpoint,
			Metadata: map[string]interface{}{
				"sourceKind": srv.SourceKind,
			},
		}
		if sc.Transport == "" {
			sc.Transport = "stdio"
		}
		cfg.Servers = append(cfg.Servers, sc)
		existingNames[srv.Name] = true
		added++
	}

	if added == 0 {
		return fmt.Errorf("all selected servers already exist in config")
	}

	a.setConfig(cfg)
	message, autoApplied, err := a.persistConfig(cfg)
	if err != nil {
		return err
	}
	a.emitConfigUpdated(cfg, message, autoApplied)
	return nil
}

func upsertSyncSourceConfig(cfg *config.Config, next config.SyncSourceConfig) {
	if cfg == nil || strings.TrimSpace(next.SourceKey) == "" {
		return
	}

	next.SyncMode = config.NormalizeSyncMode(next.SyncMode)
	next.Metadata = ensureMetadata(next.Metadata)
	for i := range cfg.SyncSources {
		if cfg.SyncSources[i].SourceKey == next.SourceKey {
			cfg.SyncSources[i] = next
			return
		}
	}
	cfg.SyncSources = append(cfg.SyncSources, next)
}

func findSyncSourceConfig(cfg *config.Config, sourceKey string) *config.SyncSourceConfig {
	if cfg == nil {
		return nil
	}
	for i := range cfg.SyncSources {
		if cfg.SyncSources[i].SourceKey == sourceKey {
			return &cfg.SyncSources[i]
		}
	}
	return nil
}

func ensureMetadata(metadata map[string]interface{}) map[string]interface{} {
	if metadata == nil {
		return map[string]interface{}{}
	}
	return metadata
}

func metadataString(metadata map[string]interface{}, key string) string {
	if metadata == nil {
		return ""
	}
	return fmt.Sprintf("%v", metadata[key])
}

func metadataBool(metadata map[string]interface{}, key string) bool {
	if metadata == nil {
		return false
	}
	value, ok := metadata[key]
	if !ok {
		return false
	}
	result, ok := value.(bool)
	return ok && result
}

func (a *App) setAuthFailure(code, message string, permanent bool) {
	a.authFailureMu.Lock()
	defer a.authFailureMu.Unlock()
	a.authFailureCode = code
	a.authFailureMessage = message
	a.authFailurePermanent = permanent
}

func (a *App) clearAuthFailure() {
	a.setAuthFailure("", "", false)
}

func (a *App) getAuthFailureCode() string {
	a.authFailureMu.RLock()
	defer a.authFailureMu.RUnlock()
	return a.authFailureCode
}

func (a *App) getAuthFailureMessage() string {
	a.authFailureMu.RLock()
	defer a.authFailureMu.RUnlock()
	return a.authFailureMessage
}

func (a *App) getAuthFailurePermanent() bool {
	a.authFailureMu.RLock()
	defer a.authFailureMu.RUnlock()
	return a.authFailurePermanent
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

func (a *App) getConfigSnapshot() *config.Config {
	a.cfgMu.RLock()
	defer a.cfgMu.RUnlock()
	return config.Clone(a.cfg)
}

func (a *App) setConfig(next *config.Config) {
	if next == nil {
		return
	}

	a.cfgMu.Lock()
	a.cfg = config.Clone(next)
	engine := a.engine
	cfgCopy := config.Clone(next)
	a.cfgMu.Unlock()

	if engine != nil {
		engine.UpdateConfig(cfgCopy)
	}
}

func (a *App) handleConfigWatchEvent(evt config.WatchEvent) {
	switch evt.Kind {
	case config.WatchEventChanged:
		nextHash := config.Fingerprint(evt.Config)
		if nextHash != "" && nextHash == a.getConfigHash() {
			return
		}
		a.setConfig(evt.Config)
		a.setConfigHash(nextHash)
		message, autoApplied, requiresRestart := a.applyConfigToRunningRelay(evt.Config)
		if message == "" {
			message = "Configuration reloaded from disk."
		}
		wailsRuntime.EventsEmit(a.ctx, "config:external-change", map[string]interface{}{
			"kind":            string(evt.Kind),
			"path":            evt.Path,
			"config":          evt.Config,
			"requiresRestart": requiresRestart,
			"autoApplied":     autoApplied,
			"message":         message,
		})
	case config.WatchEventDeleted:
		a.setConfigHash("")
		wailsRuntime.EventsEmit(a.ctx, "config:external-change", map[string]interface{}{
			"kind": string(evt.Kind),
			"path": evt.Path,
		})
	case config.WatchEventError:
		wailsRuntime.EventsEmit(a.ctx, "config:external-change", map[string]interface{}{
			"kind":    string(evt.Kind),
			"path":    evt.Path,
			"message": errorString(evt.Err),
		})
	}
}

func summarizeSecret(secret string) string {
	if len(secret) <= 12 {
		return secret
	}
	return fmt.Sprintf("%s...%s", secret[:8], secret[len(secret)-4:])
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (a *App) persistConfig(cfg *config.Config) (string, bool, error) {
	if err := config.EnsureDir(); err != nil {
		return "", false, err
	}
	if err := config.Save(a.cfgPath, cfg); err != nil {
		return "", false, err
	}
	if err := a.syncStartupPreference(cfg); err != nil {
		return "", false, err
	}

	a.setConfigHash(config.Fingerprint(cfg))
	message, autoApplied, _ := a.applyConfigToRunningRelay(cfg)
	return message, autoApplied, nil
}

func (a *App) persistConfigSilently(cfg *config.Config) error {
	if cfg == nil {
		return nil
	}
	if err := config.EnsureDir(); err != nil {
		return err
	}
	if err := config.Save(a.cfgPath, cfg); err != nil {
		return err
	}
	a.setConfig(cfg)
	a.setConfigHash(config.Fingerprint(cfg))
	return nil
}

func (a *App) saveCloseBehaviorPreference(behavior string) error {
	cfg := a.getConfigSnapshot()
	if cfg == nil {
		return nil
	}

	behavior = normalizeCloseBehavior(behavior)
	if cfg.Startup.CloseBehavior == behavior {
		return nil
	}

	cfg.Startup.CloseBehavior = behavior
	if err := a.persistConfigSilently(cfg); err != nil {
		return err
	}
	a.emitConfigUpdated(cfg, "Close behavior updated.", false)
	return nil
}

func (a *App) applyConfigToRunningRelay(cfg *config.Config) (string, bool, bool) {
	if cfg == nil || a.engine == nil {
		return "", false, false
	}

	state := a.engine.State()
	if state != relay.StateRunning && state != relay.StateStarting {
		return "", false, false
	}

	cfgCopy := config.Clone(cfg)
	if errs := config.Validate(cfgCopy); len(errs) > 0 {
		return fmt.Sprintf("Configuration updated, but relay kept the previous runtime settings: %s", errs[0]), false, true
	}

	if err := a.RestartRelay(); err != nil {
		return fmt.Sprintf("Configuration updated, but relay restart failed: %v", err), false, true
	}

	return "Configuration applied and relay restarted.", true, false
}

func (a *App) emitConfigUpdated(cfg *config.Config, message string, autoApplied bool) {
	payload := map[string]interface{}{
		"config":      config.Clone(cfg),
		"autoApplied": autoApplied,
	}
	if strings.TrimSpace(message) != "" {
		payload["message"] = message
	}
	wailsRuntime.EventsEmit(a.ctx, "config:updated", payload)
}

func (a *App) getConfigHash() string {
	a.cfgMu.RLock()
	defer a.cfgMu.RUnlock()
	return a.cfgHash
}

func (a *App) setConfigHash(hash string) {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	a.cfgHash = hash
}

func (a *App) syncStartupPreference(cfg *config.Config) error {
	if cfg == nil || !startup.IsSupported() {
		return nil
	}

	command, err := startup.Command(cfg.Startup.LaunchHidden)
	if err != nil {
		return err
	}
	return startup.Sync(cfg.Startup.RunAtLogin, command)
}

func (a *App) beforeRelayConnect(ctx context.Context) error {
	result, applied, err := a.syncDesktopUpdate(ctx, true)
	if err != nil {
		a.emitLocalLog("update", fmt.Sprintf("Update check failed: %v", err))
		return nil
	}
	if result != nil && result.Available && result.Manifest != nil && !applied && result.Downloaded {
		a.emitLocalLog("update", fmt.Sprintf("Update %s is staged and will be installed before the next launch.", result.Manifest.Version))
	}
	if !applied {
		return nil
	}

	version := ""
	if result != nil && result.Manifest != nil {
		version = result.Manifest.Version
	}
	if version != "" {
		a.emitLocalLog("update", fmt.Sprintf("Installing update %s and closing the app.", version))
	} else {
		a.emitLocalLog("update", "Installing update and closing the app.")
	}

	go func() {
		time.Sleep(250 * time.Millisecond)
		if a.ctx != nil {
			wailsRuntime.Quit(a.ctx)
		}
	}()
	return cloud.ErrRestartRequired
}

func (a *App) prefetchUpdateAfterPairing() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	result, _, err := a.syncDesktopUpdate(ctx, false)
	if err != nil {
		a.emitLocalLog("update", fmt.Sprintf("Update prefetch failed: %v", err))
		return
	}
	if result != nil && result.Available && result.Downloaded && result.Manifest != nil {
		a.emitLocalLog("update", fmt.Sprintf("Downloaded update %s. It will install before the next connection.", result.Manifest.Version))
	}
}

func (a *App) syncDesktopUpdate(ctx context.Context, apply bool) (*cloud.DesktopUpdateResult, bool, error) {
	a.updateMu.Lock()
	defer a.updateMu.Unlock()

	cfg := a.getConfigSnapshot()
	if cfg == nil || strings.TrimSpace(cfg.Relay.DeviceID) == "" || strings.TrimSpace(cfg.Relay.ServerBaseURL) == "" {
		return nil, false, nil
	}

	result, err := cloud.CheckForDesktopUpdate(ctx, cfg.Relay, cfg.Update, Version)
	if err != nil {
		return nil, false, err
	}

	changed := false
	if result != nil {
		if cfg.Update.LastCheckedAt != result.CheckedAt {
			cfg.Update.LastCheckedAt = result.CheckedAt
			changed = true
		}

		latestVersion := ""
		if result.Manifest != nil {
			latestVersion = result.Manifest.Version
		}
		if cfg.Update.LastVersion != latestVersion {
			cfg.Update.LastVersion = latestVersion
			changed = true
		}

		if result.Available && result.Downloaded {
			if cfg.Update.PendingVersion != result.Manifest.Version {
				cfg.Update.PendingVersion = result.Manifest.Version
				changed = true
			}
			if cfg.Update.PendingInstaller != result.DownloadPath {
				cfg.Update.PendingInstaller = result.DownloadPath
				changed = true
			}
		} else if strings.TrimSpace(cfg.Update.PendingVersion) == strings.TrimSpace(Version) {
			cfg.Update.PendingVersion = ""
			cfg.Update.PendingInstaller = ""
			changed = true
		}
	}

	if changed {
		if err := a.persistConfigSilently(cfg); err != nil {
			return result, false, err
		}
	}

	if !apply || result == nil || !result.Available || !result.Downloaded {
		return result, false, nil
	}
	if err := cloud.LaunchPreparedUpdate(result.DownloadPath, true); err != nil {
		return result, false, err
	}
	return result, true, nil
}

func (a *App) autoConnectAfterLaunch() {
	time.Sleep(900 * time.Millisecond)
	if err := a.StartRelay(); err != nil {
		a.emitLocalLog("auto_connect", fmt.Sprintf("Auto-connect failed: %v", err))
	}
}

func (a *App) emitLocalLog(kind, message string) {
	entry := LogEntry{
		Time:    time.Now().Format("15:04:05"),
		Type:    kind,
		Message: message,
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
			"data":    map[string]interface{}{},
		})
	}
}

func (a *App) initialiseTray() error {
	manager, err := tray.New("Synapse Relay", a.showWindowFromTray, a.quitFromTray)
	if err != nil {
		return err
	}
	a.tray = manager
	return nil
}

func (a *App) showWindowFromTray() {
	if a.ctx == nil {
		return
	}
	wailsRuntime.WindowShow(a.ctx)
	a.setWindowHidden(false)
}

func (a *App) hideWindowToTray(ctx context.Context) {
	if ctx == nil {
		return
	}
	wailsRuntime.WindowHide(ctx)
	a.setWindowHidden(true)
	a.notifyTray("Synapse Relay", "Relay is still running in the background.", false)
}

func (a *App) quitFromTray() {
	if a.ctx == nil {
		return
	}
	a.setAllowQuit(true)
	wailsRuntime.Quit(a.ctx)
}

func (a *App) syncStartupStateFromSystem(cfg *config.Config) (bool, error) {
	if cfg == nil || !startup.IsSupported() {
		return false, nil
	}

	enabled, err := startup.IsEnabled()
	if err != nil {
		return false, err
	}
	if cfg.Startup.RunAtLogin == enabled {
		return false, nil
	}

	cfg.Startup.RunAtLogin = enabled
	return true, nil
}

func (a *App) maybeNotifyBackgroundEvent(evt relay.Event) {
	if !a.isWindowHidden() || a.tray == nil || !a.tray.Available() {
		return
	}

	cfg := a.getConfigSnapshot()
	if cfg == nil || !cfg.Notifications.BackgroundEnabled {
		return
	}

	switch evt.Type {
	case relay.EventConnected:
		a.notifyTray("Synapse Relay", "Relay connected successfully.", false)
	case relay.EventDisconnected:
		if a.engine != nil {
			state := a.engine.State()
			if state == relay.StateStopping || state == relay.StateStopped {
				return
			}
		}
		a.notifyTray("Synapse Relay", "Relay disconnected and will retry.", true)
	case relay.EventAuthFailed, relay.EventError:
		if strings.TrimSpace(evt.Message) == "" {
			return
		}
		a.notifyTray("Synapse Relay", evt.Message, true)
	}
}

func (a *App) notifyTray(title, message string, warning bool) {
	if a.tray == nil || !a.tray.Available() || strings.TrimSpace(message) == "" {
		return
	}
	if err := a.tray.ShowNotification(title, message, warning); err != nil {
		log.Printf("Warning: failed to show tray notification: %v", err)
	}
}

func (a *App) setWindowHidden(hidden bool) {
	a.windowStateMu.Lock()
	defer a.windowStateMu.Unlock()
	a.windowHidden = hidden
}

func (a *App) isWindowHidden() bool {
	a.windowStateMu.RLock()
	defer a.windowStateMu.RUnlock()
	return a.windowHidden
}

func (a *App) setAllowQuit(allow bool) {
	a.windowStateMu.Lock()
	defer a.windowStateMu.Unlock()
	a.allowQuit = allow
}

func (a *App) shouldAllowQuit() bool {
	a.windowStateMu.RLock()
	defer a.windowStateMu.RUnlock()
	return a.allowQuit
}

func hasLaunchAtLoginArg(args []string) bool {
	for _, arg := range args {
		if strings.TrimSpace(arg) == startup.LaunchAtLoginFlag {
			return true
		}
	}
	return false
}
