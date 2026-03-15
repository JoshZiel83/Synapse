package config

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type RelayConfig struct {
	ServerBaseURL         string `yaml:"server_base_url" json:"serverBaseUrl"`
	WebSocketURL          string `yaml:"websocket_url" json:"websocketUrl"`
	DeviceID              string `yaml:"device_id" json:"deviceId"`
	DisplayName           string `yaml:"display_name" json:"displayName"`
	PublicKeyFingerprint  string `yaml:"public_key_fingerprint" json:"publicKeyFingerprint"`
	ServerTLSPublicKeyPin string `yaml:"server_tls_public_key_pin" json:"serverTlsPublicKeyPin"`
	PrivateKeyPath        string `yaml:"private_key_path" json:"privateKeyPath"`
}

type StartupConfig struct {
	RunAtLogin   bool `yaml:"run_at_login" json:"runAtLogin"`
	AutoConnect  bool `yaml:"auto_connect" json:"autoConnect"`
	LaunchHidden bool `yaml:"launch_hidden" json:"launchHidden"`
}

type NotificationConfig struct {
	BackgroundEnabled bool `yaml:"background_enabled" json:"backgroundEnabled"`
}

type UpdateConfig struct {
	Channel          string `yaml:"channel" json:"channel"`
	LastCheckedAt    string `yaml:"last_checked_at" json:"lastCheckedAt,omitempty"`
	LastVersion      string `yaml:"last_version" json:"lastVersion,omitempty"`
	PendingVersion   string `yaml:"pending_version" json:"pendingVersion,omitempty"`
	PendingInstaller string `yaml:"pending_installer" json:"pendingInstaller,omitempty"`
}

type SyncSourceConfig struct {
	SourceKind   string                 `yaml:"source_kind" json:"sourceKind"`
	SourceKey    string                 `yaml:"source_key" json:"sourceKey"`
	ConfigPath   string                 `yaml:"config_path" json:"configPath,omitempty"`
	SyncMode     string                 `yaml:"sync_mode" json:"syncMode"`
	Status       string                 `yaml:"status" json:"status"`
	LastSyncedAt string                 `yaml:"last_synced_at" json:"lastSyncedAt,omitempty"`
	LastError    string                 `yaml:"last_error" json:"lastError,omitempty"`
	Metadata     map[string]interface{} `yaml:"metadata" json:"metadata,omitempty"`
}

type BuiltinDisplaySelectorConfig struct {
	Mode       string `yaml:"mode,omitempty" json:"mode,omitempty"`
	Index      int    `yaml:"index,omitempty" json:"index,omitempty"`
	ID         int    `yaml:"id,omitempty" json:"id,omitempty"`
	ElectronID int64  `yaml:"electron_id,omitempty" json:"electronId,omitempty"`
}

type BuiltinCUAConfig struct {
	ReadOnly             *bool                        `yaml:"read_only,omitempty" json:"readOnly,omitempty"`
	RelativeCoordinate   bool                         `yaml:"relative_coordinate,omitempty" json:"relativeCoordinate,omitempty"`
	ImageSize            [2]int                       `yaml:"image_size,omitempty" json:"imageSize,omitempty"`
	RelativeSize         [2]int                       `yaml:"relative_size,omitempty" json:"relativeSize,omitempty"`
	ScrollMultiplier     float64                      `yaml:"scroll_multiplier,omitempty" json:"scrollMultiplier,omitempty"`
	LogDir               string                       `yaml:"log_dir,omitempty" json:"logDir,omitempty"`
	AllowDisplayOverride *bool                        `yaml:"allow_display_override,omitempty" json:"allowDisplayOverride,omitempty"`
	IncludeOverviewTool  *bool                        `yaml:"include_overview_tool,omitempty" json:"includeOverviewTool,omitempty"`
	DisplaySelector      BuiltinDisplaySelectorConfig `yaml:"display_selector,omitempty" json:"displaySelector,omitempty"`
}

type BuiltinServerConfig struct {
	Kind       string            `yaml:"kind" json:"kind"`
	InstanceID string            `yaml:"instance_id,omitempty" json:"instanceId,omitempty"`
	CUA        *BuiltinCUAConfig `yaml:"cua,omitempty" json:"cua,omitempty"`
}

type Config struct {
	Relay         RelayConfig        `yaml:"relay" json:"relay"`
	Startup       StartupConfig      `yaml:"startup" json:"startup"`
	Notifications NotificationConfig `yaml:"notifications" json:"notifications"`
	Update        UpdateConfig       `yaml:"update" json:"update"`
	LogLevel      string             `yaml:"log_level" json:"logLevel"`
	SyncSources   []SyncSourceConfig `yaml:"sync_sources" json:"syncSources"`
	Servers       []ServerConfig     `yaml:"servers" json:"servers"`
}

type ServerConfig struct {
	StableKey      string                 `yaml:"stable_key" json:"stableKey,omitempty"`
	SyncSourceKey  string                 `yaml:"sync_source_key" json:"syncSourceKey,omitempty"`
	ManagementMode string                 `yaml:"management_mode" json:"managementMode,omitempty"`
	Enabled        *bool                  `yaml:"enabled,omitempty" json:"enabled,omitempty"`
	Name           string                 `yaml:"name" json:"name"`
	Transport      string                 `yaml:"transport" json:"transport"`
	Command        string                 `yaml:"command" json:"command,omitempty"`
	Args           []string               `yaml:"args" json:"args,omitempty"`
	Env            map[string]string      `yaml:"env" json:"env,omitempty"`
	Endpoint       string                 `yaml:"endpoint" json:"endpoint,omitempty"`
	Builtin        *BuiltinServerConfig   `yaml:"builtin,omitempty" json:"builtin,omitempty"`
	Metadata       map[string]interface{} `yaml:"metadata" json:"metadata,omitempty"`
}

func Clone(cfg *Config) *Config {
	if cfg == nil {
		return nil
	}

	clone := &Config{
		Relay: RelayConfig{
			ServerBaseURL:         cfg.Relay.ServerBaseURL,
			WebSocketURL:          cfg.Relay.WebSocketURL,
			DeviceID:              cfg.Relay.DeviceID,
			DisplayName:           cfg.Relay.DisplayName,
			PublicKeyFingerprint:  cfg.Relay.PublicKeyFingerprint,
			ServerTLSPublicKeyPin: cfg.Relay.ServerTLSPublicKeyPin,
			PrivateKeyPath:        cfg.Relay.PrivateKeyPath,
		},
		Startup: StartupConfig{
			RunAtLogin:   cfg.Startup.RunAtLogin,
			AutoConnect:  cfg.Startup.AutoConnect,
			LaunchHidden: cfg.Startup.LaunchHidden,
		},
		Notifications: NotificationConfig{
			BackgroundEnabled: cfg.Notifications.BackgroundEnabled,
		},
		Update: UpdateConfig{
			Channel:          cfg.Update.Channel,
			LastCheckedAt:    cfg.Update.LastCheckedAt,
			LastVersion:      cfg.Update.LastVersion,
			PendingVersion:   cfg.Update.PendingVersion,
			PendingInstaller: cfg.Update.PendingInstaller,
		},
		LogLevel:    cfg.LogLevel,
		SyncSources: make([]SyncSourceConfig, len(cfg.SyncSources)),
		Servers:     make([]ServerConfig, len(cfg.Servers)),
	}

	for i, source := range cfg.SyncSources {
		clone.SyncSources[i] = SyncSourceConfig{
			SourceKind:   source.SourceKind,
			SourceKey:    source.SourceKey,
			ConfigPath:   source.ConfigPath,
			SyncMode:     source.SyncMode,
			Status:       source.Status,
			LastSyncedAt: source.LastSyncedAt,
			LastError:    source.LastError,
			Metadata:     cloneMetadata(source.Metadata),
		}
	}

	for i, server := range cfg.Servers {
		args := make([]string, len(server.Args))
		copy(args, server.Args)

		env := make(map[string]string, len(server.Env))
		for key, value := range server.Env {
			env[key] = value
		}

		clone.Servers[i] = ServerConfig{
			StableKey:      server.StableKey,
			SyncSourceKey:  server.SyncSourceKey,
			ManagementMode: server.ManagementMode,
			Enabled:        cloneBoolPtr(server.Enabled),
			Name:           server.Name,
			Transport:      server.Transport,
			Command:        server.Command,
			Args:           args,
			Env:            env,
			Endpoint:       server.Endpoint,
			Builtin:        cloneBuiltin(server.Builtin),
			Metadata:       cloneMetadata(server.Metadata),
		}
	}

	return clone
}

// DefaultDir returns the default config directory (~/.synapse-relay/)
func DefaultDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".synapse-relay"
	}
	return filepath.Join(home, ".synapse-relay")
}

// DefaultPath returns the default config file path (~/.synapse-relay/config.yaml)
func DefaultPath() string {
	return filepath.Join(DefaultDir(), "config.yaml")
}

func DefaultPrivateKeyPath() string {
	return filepath.Join(DefaultDir(), "device-key.pem")
}

// EnsureDir creates the ~/.synapse-relay/ directory if it doesn't exist
func EnsureDir() error {
	return os.MkdirAll(DefaultDir(), 0755)
}

// Resolve finds the config file path using cascade:
// explicit flag -> ./config.yaml -> ~/.synapse-relay/config.yaml -> empty
func Resolve(explicit string) string {
	if explicit != "" {
		return explicit
	}

	if _, err := os.Stat("config.yaml"); err == nil {
		return "config.yaml"
	}

	dp := DefaultPath()
	if _, err := os.Stat(dp); err == nil {
		return dp
	}

	return ""
}

// Load reads and validates a config from a file path
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	applyDefaults(&cfg)

	for i, s := range cfg.Servers {
		if s.Name == "" {
			return nil, fmt.Errorf("server[%d]: name is required", i)
		}
		if err := validateServerConfig(s); err != nil {
			return nil, fmt.Errorf("server[%d] (%s): %w", i, s.Name, err)
		}
	}

	return &cfg, nil
}

// LoadOrDefault tries to load a config file; if path is empty, returns a default Config
func LoadOrDefault(path string) (*Config, error) {
	if path == "" {
		cfg := &Config{LogLevel: "info"}
		applyDefaults(cfg)
		return cfg, nil
	}
	return Load(path)
}

// Validate returns a list of validation errors (non-fatal, for GUI use)
func Validate(cfg *Config) []string {
	var errs []string

	applyDefaults(cfg)

	if cfg.Relay.WebSocketURL == "" {
		errs = append(errs, "relay.websocket_url is required")
	}
	if cfg.Relay.DeviceID == "" {
		errs = append(errs, "relay.device_id is required")
	}
	if cfg.Relay.PrivateKeyPath == "" {
		errs = append(errs, "relay.private_key_path is required")
	}
	if err := validateRelayEndpoint(cfg.Relay.ServerBaseURL, false); err != nil {
		errs = append(errs, fmt.Sprintf("relay.server_base_url %s", err.Error()))
	}
	if err := validateRelayEndpoint(cfg.Relay.WebSocketURL, true); err != nil {
		errs = append(errs, fmt.Sprintf("relay.websocket_url %s", err.Error()))
	}
	if requiresRelayTLSPin(cfg.Relay.WebSocketURL) && cfg.Relay.DeviceID != "" && strings.TrimSpace(cfg.Relay.ServerTLSPublicKeyPin) == "" {
		errs = append(errs, "relay.server_tls_public_key_pin is required for secure remote relay servers")
	}

	for i, s := range cfg.Servers {
		if s.Name == "" {
			errs = append(errs, fmt.Sprintf("server[%d]: name is required", i))
			continue
		}
		if err := validateServerConfig(s); err != nil {
			errs = append(errs, fmt.Sprintf("server %q: %s", s.Name, err.Error()))
		}
	}

	return errs
}

// Save writes a config to a file atomically (write to .tmp, rename)
func Save(path string, cfg *Config) error {
	applyDefaults(cfg)

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create dir: %w", err)
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("write tmp: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("rename: %w", err)
	}

	return nil
}

func applyDefaults(cfg *Config) {
	if cfg == nil {
		return
	}

	if cfg.LogLevel == "" {
		cfg.LogLevel = "info"
	}
	if cfg.Update.Channel == "" {
		cfg.Update.Channel = "stable"
	}

	if cfg.Relay.PrivateKeyPath == "" {
		cfg.Relay.PrivateKeyPath = DefaultPrivateKeyPath()
	}
	if cfg.Relay.WebSocketURL == "" && cfg.Relay.ServerBaseURL != "" {
		cfg.Relay.WebSocketURL = DeriveWebSocketURL(cfg.Relay.ServerBaseURL)
	}

	for i := range cfg.SyncSources {
		if cfg.SyncSources[i].SyncMode == "" {
			cfg.SyncSources[i].SyncMode = "observe"
		}
		if cfg.SyncSources[i].Status == "" {
			cfg.SyncSources[i].Status = "unknown"
		}
		if cfg.SyncSources[i].Metadata == nil {
			cfg.SyncSources[i].Metadata = map[string]interface{}{}
		}
	}

	for i := range cfg.Servers {
		if cfg.Servers[i].Transport == "" {
			cfg.Servers[i].Transport = "stdio"
		}
		if cfg.Servers[i].Enabled == nil {
			cfg.Servers[i].Enabled = boolPtr(true)
		}
		if cfg.Servers[i].ManagementMode == "" {
			if cfg.Servers[i].Transport == "builtin" {
				cfg.Servers[i].ManagementMode = "builtin"
			} else if cfg.Servers[i].SyncSourceKey != "" {
				cfg.Servers[i].ManagementMode = "imported"
			} else {
				cfg.Servers[i].ManagementMode = "manual"
			}
		}
		applyBuiltinDefaults(&cfg.Servers[i])
		if cfg.Servers[i].StableKey == "" {
			cfg.Servers[i].StableKey = StableKeyForServer(cfg.Servers[i])
		}
		if cfg.Servers[i].Metadata == nil {
			cfg.Servers[i].Metadata = map[string]interface{}{}
		}
	}
}

func StableKeyForServer(server ServerConfig) string {
	builtinKind := ""
	builtinInstance := ""
	if server.Builtin != nil {
		builtinKind = server.Builtin.Kind
		builtinInstance = server.Builtin.InstanceID
	}
	name := server.Name
	if server.Transport == "builtin" {
		name = ""
	}
	base := strings.Join([]string{
		server.Transport,
		builtinKind,
		builtinInstance,
		server.Command,
		strings.Join(server.Args, "\x00"),
		server.Endpoint,
		name,
	}, "\x1f")
	hash := sha256.Sum256([]byte(base))
	return "srv_" + hex.EncodeToString(hash[:12])
}

func cloneMetadata(input map[string]interface{}) map[string]interface{} {
	if len(input) == 0 {
		return map[string]interface{}{}
	}

	output := make(map[string]interface{}, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func cloneBuiltin(input *BuiltinServerConfig) *BuiltinServerConfig {
	if input == nil {
		return nil
	}

	clone := &BuiltinServerConfig{
		Kind:       input.Kind,
		InstanceID: input.InstanceID,
	}
	if input.CUA != nil {
		clone.CUA = &BuiltinCUAConfig{
			ReadOnly:             cloneBoolPtr(input.CUA.ReadOnly),
			RelativeCoordinate:   input.CUA.RelativeCoordinate,
			ImageSize:            input.CUA.ImageSize,
			RelativeSize:         input.CUA.RelativeSize,
			ScrollMultiplier:     input.CUA.ScrollMultiplier,
			LogDir:               input.CUA.LogDir,
			AllowDisplayOverride: cloneBoolPtr(input.CUA.AllowDisplayOverride),
			IncludeOverviewTool:  cloneBoolPtr(input.CUA.IncludeOverviewTool),
			DisplaySelector:      input.CUA.DisplaySelector,
		}
	}
	return clone
}

func ServerEnabled(server ServerConfig) bool {
	return server.Enabled == nil || *server.Enabled
}

func boolPtr(value bool) *bool {
	return &value
}

func cloneBoolPtr(value *bool) *bool {
	if value == nil {
		return nil
	}
	clone := *value
	return &clone
}

func applyBuiltinDefaults(server *ServerConfig) {
	if server == nil || server.Transport != "builtin" {
		return
	}
	if server.Builtin == nil {
		server.Builtin = &BuiltinServerConfig{}
	}
	if server.Builtin.InstanceID == "" {
		server.Builtin.InstanceID = "default"
	}
	switch server.Builtin.Kind {
	case "", "cua":
		server.Builtin.Kind = "cua"
		if server.Builtin.CUA == nil {
			server.Builtin.CUA = &BuiltinCUAConfig{}
		}
		if server.Builtin.CUA.ImageSize == [2]int{} {
			server.Builtin.CUA.ImageSize = [2]int{1280, 800}
		}
		if server.Builtin.CUA.RelativeSize == [2]int{} {
			server.Builtin.CUA.RelativeSize = [2]int{1000, 1000}
		}
		if server.Builtin.CUA.ReadOnly == nil {
			server.Builtin.CUA.ReadOnly = boolPtr(false)
		}
		if server.Builtin.CUA.ScrollMultiplier == 0 {
			server.Builtin.CUA.ScrollMultiplier = 1
		}
		if server.Builtin.CUA.AllowDisplayOverride == nil {
			server.Builtin.CUA.AllowDisplayOverride = boolPtr(true)
		}
		if server.Builtin.CUA.IncludeOverviewTool == nil {
			server.Builtin.CUA.IncludeOverviewTool = boolPtr(true)
		}
		if server.Builtin.CUA.DisplaySelector.Mode == "" {
			server.Builtin.CUA.DisplaySelector.Mode = "main"
		}
	}
}

func validateServerConfig(server ServerConfig) error {
	switch server.Transport {
	case "stdio":
		if server.Command == "" {
			return fmt.Errorf("command is required for stdio transport")
		}
	case "http":
		if server.Endpoint == "" {
			return fmt.Errorf("endpoint is required for http transport")
		}
	case "builtin":
		if server.Builtin == nil {
			return fmt.Errorf("builtin config is required for builtin transport")
		}
		if strings.TrimSpace(server.Builtin.Kind) == "" {
			return fmt.Errorf("builtin.kind is required for builtin transport")
		}
		switch server.Builtin.Kind {
		case "cua":
			if server.Builtin.CUA == nil {
				return fmt.Errorf("builtin.cua is required for builtin kind %q", server.Builtin.Kind)
			}
			if server.Builtin.CUA.ImageSize[0] <= 0 || server.Builtin.CUA.ImageSize[1] <= 0 {
				return fmt.Errorf("builtin.cua.image_size must contain positive width and height")
			}
			if server.Builtin.CUA.RelativeSize[0] <= 0 || server.Builtin.CUA.RelativeSize[1] <= 0 {
				return fmt.Errorf("builtin.cua.relative_size must contain positive width and height")
			}
			if server.Builtin.CUA.ScrollMultiplier <= 0 {
				return fmt.Errorf("builtin.cua.scroll_multiplier must be greater than 0")
			}
			switch server.Builtin.CUA.DisplaySelector.Mode {
			case "", "main", "mouse":
			case "index":
				if server.Builtin.CUA.DisplaySelector.Index < 0 {
					return fmt.Errorf("builtin.cua.display_selector.index must be >= 0")
				}
			case "id":
				if server.Builtin.CUA.DisplaySelector.ID == 0 {
					return fmt.Errorf("builtin.cua.display_selector.id is required")
				}
			case "electron_id":
				if server.Builtin.CUA.DisplaySelector.ElectronID == 0 {
					return fmt.Errorf("builtin.cua.display_selector.electron_id is required")
				}
			default:
				return fmt.Errorf("builtin.cua.display_selector.mode %q is unsupported", server.Builtin.CUA.DisplaySelector.Mode)
			}
		default:
			return fmt.Errorf("builtin kind %q is unsupported", server.Builtin.Kind)
		}
	default:
		return fmt.Errorf("unsupported transport %q", server.Transport)
	}
	return nil
}

func Fingerprint(cfg *Config) string {
	if cfg == nil {
		return ""
	}

	clone := Clone(cfg)
	applyDefaults(clone)

	data, err := yaml.Marshal(clone)
	if err != nil {
		return ""
	}

	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func DeriveWebSocketURL(serverBaseURL string) string {
	base := NormalizeServerBaseURL(serverBaseURL)
	if base == "" {
		return ""
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return base
	}
	if parsed.Scheme == "https" {
		parsed.Scheme = "wss"
	} else if parsed.Scheme == "http" {
		parsed.Scheme = "ws"
	}
	parsed.Path = "/ws/relay"
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func NormalizeServerBaseURL(serverBaseURL string) string {
	base := strings.TrimSpace(strings.TrimRight(serverBaseURL, "/"))
	if base == "" {
		return ""
	}

	parsed, err := url.Parse(base)
	if err != nil {
		return base
	}
	parsed.Path = ""
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/")
}

func validateRelayEndpoint(raw string, websocket bool) error {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil
	}

	parsed, err := url.Parse(value)
	if err != nil {
		return fmt.Errorf("must be a valid URL")
	}
	if parsed.Host == "" || parsed.Scheme == "" {
		return fmt.Errorf("must include scheme and host")
	}

	scheme := strings.ToLower(parsed.Scheme)
	host := parsed.Hostname()
	switch scheme {
	case "https", "wss":
		return nil
	case "http", "ws":
		if isLoopbackRelayHost(host) {
			return nil
		}
		if websocket {
			return fmt.Errorf("must use wss unless host is loopback")
		}
		return fmt.Errorf("must use https unless host is loopback")
	default:
		if websocket {
			return fmt.Errorf("must use ws or wss")
		}
		return fmt.Errorf("must use http or https")
	}
}

func requiresRelayTLSPin(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}

	switch strings.ToLower(parsed.Scheme) {
	case "https", "wss":
		return true
	default:
		return false
	}
}

func isLoopbackRelayHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
