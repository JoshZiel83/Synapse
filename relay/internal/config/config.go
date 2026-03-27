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
	"time"

	"gopkg.in/yaml.v3"
)

const (
	defaultBuiltinCommandlineMaxTimeoutSec      int64 = 300
	defaultBuiltinFilesystemMaxGetFileSizeBytes       = 20 * 1024 * 1024
	CloseBehaviorAsk                                  = "ask"
	CloseBehaviorTray                                 = "tray"
	CloseBehaviorQuit                                 = "quit"
	SyncModeSnapshot                                  = "snapshot"
	SyncModeFollow                                    = "follow"
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
	RunAtLogin    bool   `yaml:"run_at_login" json:"runAtLogin"`
	AutoConnect   bool   `yaml:"auto_connect" json:"autoConnect"`
	LaunchHidden  bool   `yaml:"launch_hidden" json:"launchHidden"`
	CloseBehavior string `yaml:"close_behavior,omitempty" json:"closeBehavior,omitempty"`
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

type BuiltinFilesystemRootConfig struct {
	Path   string `yaml:"path" json:"path"`
	Access string `yaml:"access,omitempty" json:"access,omitempty"`
}

type BuiltinFilesystemIndexConfig struct {
	ContentEnabled   *bool    `yaml:"content_enabled,omitempty" json:"contentEnabled,omitempty"`
	FileTypes        []string `yaml:"file_types,omitempty" json:"fileTypes,omitempty"`
	MaxFileSizeBytes int64    `yaml:"max_file_size_bytes,omitempty" json:"maxFileSizeBytes,omitempty"`
	ParsePDF         *bool    `yaml:"parse_pdf,omitempty" json:"parsePdf,omitempty"`
	ParseOffice      *bool    `yaml:"parse_office,omitempty" json:"parseOffice,omitempty"`
	ParseImages      *bool    `yaml:"parse_images,omitempty" json:"parseImages,omitempty"`
}

type BuiltinFilesystemConfig struct {
	ReadOnly            *bool                         `yaml:"read_only,omitempty" json:"readOnly,omitempty"`
	Scope               string                        `yaml:"scope,omitempty" json:"scope,omitempty"`
	GlobalAccess        string                        `yaml:"global_access,omitempty" json:"globalAccess,omitempty"`
	MaxGetFileSizeBytes int64                         `yaml:"max_get_file_size_bytes,omitempty" json:"maxGetFileSizeBytes,omitempty"`
	Roots               []BuiltinFilesystemRootConfig `yaml:"roots,omitempty" json:"roots,omitempty"`
	Index               BuiltinFilesystemIndexConfig  `yaml:"index,omitempty" json:"index,omitempty"`
}

type BuiltinChromeConfig struct {
	ConnectionMode          string            `yaml:"connection_mode,omitempty" json:"connectionMode,omitempty"`
	Channel                 string            `yaml:"channel,omitempty" json:"channel,omitempty"`
	ExecutablePath          string            `yaml:"executable_path,omitempty" json:"executablePath,omitempty"`
	UserDataDir             string            `yaml:"user_data_dir,omitempty" json:"userDataDir,omitempty"`
	BrowserURL              string            `yaml:"browser_url,omitempty" json:"browserUrl,omitempty"`
	WSEndpoint              string            `yaml:"ws_endpoint,omitempty" json:"wsEndpoint,omitempty"`
	WSHeaders               map[string]string `yaml:"ws_headers,omitempty" json:"wsHeaders,omitempty"`
	Headless                *bool             `yaml:"headless,omitempty" json:"headless,omitempty"`
	Isolated                *bool             `yaml:"isolated,omitempty" json:"isolated,omitempty"`
	AcceptInsecureCerts     *bool             `yaml:"accept_insecure_certs,omitempty" json:"acceptInsecureCerts,omitempty"`
	LogFile                 string            `yaml:"log_file,omitempty" json:"logFile,omitempty"`
	ChromeArgs              []string          `yaml:"chrome_args,omitempty" json:"chromeArgs,omitempty"`
	IgnoreDefaultChromeArgs []string          `yaml:"ignore_default_chrome_args,omitempty" json:"ignoreDefaultChromeArgs,omitempty"`
	Slim                    *bool             `yaml:"slim,omitempty" json:"slim,omitempty"`
	UsageStatistics         *bool             `yaml:"usage_statistics,omitempty" json:"usageStatistics,omitempty"`
	PerformanceCrux         *bool             `yaml:"performance_crux,omitempty" json:"performanceCrux,omitempty"`
}

type BuiltinCommandlineConfig struct {
	DefaultCWD    string `yaml:"default_cwd,omitempty" json:"defaultCwd,omitempty"`
	MaxTimeoutSec int64  `yaml:"max_timeout_sec,omitempty" json:"maxTimeoutSec,omitempty"`
}

type BuiltinServerConfig struct {
	Kind        string                    `yaml:"kind" json:"kind"`
	InstanceID  string                    `yaml:"instance_id,omitempty" json:"instanceId,omitempty"`
	CUA         *BuiltinCUAConfig         `yaml:"cua,omitempty" json:"cua,omitempty"`
	Filesystem  *BuiltinFilesystemConfig  `yaml:"filesystem,omitempty" json:"filesystem,omitempty"`
	Chrome      *BuiltinChromeConfig      `yaml:"chrome,omitempty" json:"chrome,omitempty"`
	Commandline *BuiltinCommandlineConfig `yaml:"commandline,omitempty" json:"commandline,omitempty"`
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
	StableKey     string                 `yaml:"stable_key" json:"stableKey,omitempty"`
	SyncSourceKey string                 `yaml:"sync_source_key" json:"syncSourceKey,omitempty"`
	Enabled       *bool                  `yaml:"enabled,omitempty" json:"enabled,omitempty"`
	Name          string                 `yaml:"name" json:"name"`
	Transport     string                 `yaml:"transport" json:"transport"`
	Command       string                 `yaml:"command" json:"command,omitempty"`
	Args          []string               `yaml:"args" json:"args,omitempty"`
	Env           map[string]string      `yaml:"env" json:"env,omitempty"`
	Endpoint      string                 `yaml:"endpoint" json:"endpoint,omitempty"`
	Builtin       *BuiltinServerConfig   `yaml:"builtin,omitempty" json:"builtin,omitempty"`
	Metadata      map[string]interface{} `yaml:"metadata" json:"metadata,omitempty"`
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
			RunAtLogin:    cfg.Startup.RunAtLogin,
			AutoConnect:   cfg.Startup.AutoConnect,
			LaunchHidden:  cfg.Startup.LaunchHidden,
			CloseBehavior: cfg.Startup.CloseBehavior,
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
			StableKey:     server.StableKey,
			SyncSourceKey: server.SyncSourceKey,
			Enabled:       cloneBoolPtr(server.Enabled),
			Name:          server.Name,
			Transport:     server.Transport,
			Command:       server.Command,
			Args:          args,
			Env:           env,
			Endpoint:      server.Endpoint,
			Builtin:       cloneBuiltin(server.Builtin),
			Metadata:      cloneMetadata(server.Metadata),
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
		if !ServerEnabled(s) {
			continue
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
	switch cfg.Startup.CloseBehavior {
	case CloseBehaviorAsk, CloseBehaviorTray, CloseBehaviorQuit:
	default:
		errs = append(errs, fmt.Sprintf("startup.close_behavior %q is unsupported", cfg.Startup.CloseBehavior))
	}

	for i, s := range cfg.Servers {
		if s.Name == "" {
			errs = append(errs, fmt.Sprintf("server[%d]: name is required", i))
			continue
		}
		if !ServerEnabled(s) {
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
	if strings.TrimSpace(cfg.Startup.CloseBehavior) == "" {
		cfg.Startup.CloseBehavior = CloseBehaviorAsk
	}

	for i := range cfg.SyncSources {
		cfg.SyncSources[i].SyncMode = NormalizeSyncMode(cfg.SyncSources[i].SyncMode)
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
		applyBuiltinDefaults(&cfg.Servers[i])
		if cfg.Servers[i].StableKey == "" {
			cfg.Servers[i].StableKey = StableKeyForServer(cfg.Servers[i])
		}
		if cfg.Servers[i].Metadata == nil {
			cfg.Servers[i].Metadata = map[string]interface{}{}
		}
	}
}

func NormalizeSyncMode(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case SyncModeSnapshot, "import_only", "detached":
		return SyncModeSnapshot
	case "follow", "observe", "mirror", "managed", "":
		return SyncModeFollow
	default:
		return SyncModeFollow
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
	if input.Filesystem != nil {
		fileTypes := make([]string, len(input.Filesystem.Index.FileTypes))
		copy(fileTypes, input.Filesystem.Index.FileTypes)

		roots := make([]BuiltinFilesystemRootConfig, len(input.Filesystem.Roots))
		copy(roots, input.Filesystem.Roots)

		clone.Filesystem = &BuiltinFilesystemConfig{
			ReadOnly:            cloneBoolPtr(input.Filesystem.ReadOnly),
			Scope:               input.Filesystem.Scope,
			GlobalAccess:        input.Filesystem.GlobalAccess,
			MaxGetFileSizeBytes: input.Filesystem.MaxGetFileSizeBytes,
			Roots:               roots,
			Index: BuiltinFilesystemIndexConfig{
				ContentEnabled:   cloneBoolPtr(input.Filesystem.Index.ContentEnabled),
				FileTypes:        fileTypes,
				MaxFileSizeBytes: input.Filesystem.Index.MaxFileSizeBytes,
				ParsePDF:         cloneBoolPtr(input.Filesystem.Index.ParsePDF),
				ParseOffice:      cloneBoolPtr(input.Filesystem.Index.ParseOffice),
				ParseImages:      cloneBoolPtr(input.Filesystem.Index.ParseImages),
			},
		}
	}
	if input.Chrome != nil {
		chromeArgs := make([]string, len(input.Chrome.ChromeArgs))
		copy(chromeArgs, input.Chrome.ChromeArgs)

		ignoreDefaultChromeArgs := make([]string, len(input.Chrome.IgnoreDefaultChromeArgs))
		copy(ignoreDefaultChromeArgs, input.Chrome.IgnoreDefaultChromeArgs)

		wsHeaders := make(map[string]string, len(input.Chrome.WSHeaders))
		for key, value := range input.Chrome.WSHeaders {
			wsHeaders[key] = value
		}

		clone.Chrome = &BuiltinChromeConfig{
			ConnectionMode:          input.Chrome.ConnectionMode,
			Channel:                 input.Chrome.Channel,
			ExecutablePath:          input.Chrome.ExecutablePath,
			UserDataDir:             input.Chrome.UserDataDir,
			BrowserURL:              input.Chrome.BrowserURL,
			WSEndpoint:              input.Chrome.WSEndpoint,
			WSHeaders:               wsHeaders,
			Headless:                cloneBoolPtr(input.Chrome.Headless),
			Isolated:                cloneBoolPtr(input.Chrome.Isolated),
			AcceptInsecureCerts:     cloneBoolPtr(input.Chrome.AcceptInsecureCerts),
			LogFile:                 input.Chrome.LogFile,
			ChromeArgs:              chromeArgs,
			IgnoreDefaultChromeArgs: ignoreDefaultChromeArgs,
			Slim:                    cloneBoolPtr(input.Chrome.Slim),
			UsageStatistics:         cloneBoolPtr(input.Chrome.UsageStatistics),
			PerformanceCrux:         cloneBoolPtr(input.Chrome.PerformanceCrux),
		}
	}
	if input.Commandline != nil {
		clone.Commandline = &BuiltinCommandlineConfig{
			DefaultCWD:    input.Commandline.DefaultCWD,
			MaxTimeoutSec: input.Commandline.MaxTimeoutSec,
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
	if server.Builtin.Kind == "" {
		switch {
		case server.Builtin.Chrome != nil:
			server.Builtin.Kind = "chrome"
		case server.Builtin.Filesystem != nil:
			server.Builtin.Kind = "filesystem"
		case server.Builtin.Commandline != nil:
			server.Builtin.Kind = "commandline"
		}
	}
	switch server.Builtin.Kind {
	case "", "cua":
		server.Builtin.Kind = "cua"
		if server.Builtin.InstanceID == "" {
			server.Builtin.InstanceID = "cua_default"
		}
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
	case "filesystem":
		if server.Builtin.InstanceID == "" {
			server.Builtin.InstanceID = "filesystem_default"
		}
		if server.Builtin.Filesystem == nil {
			server.Builtin.Filesystem = &BuiltinFilesystemConfig{}
		}
		if server.Builtin.Filesystem.ReadOnly == nil {
			server.Builtin.Filesystem.ReadOnly = boolPtr(false)
		}
		if strings.TrimSpace(server.Builtin.Filesystem.Scope) == "" {
			server.Builtin.Filesystem.Scope = "roots"
		}
		if strings.TrimSpace(server.Builtin.Filesystem.GlobalAccess) == "" {
			server.Builtin.Filesystem.GlobalAccess = "ro"
		}
		if server.Builtin.Filesystem.MaxGetFileSizeBytes == 0 {
			server.Builtin.Filesystem.MaxGetFileSizeBytes = defaultBuiltinFilesystemMaxGetFileSizeBytes
		}
		if server.Builtin.Filesystem.Index.ContentEnabled == nil {
			server.Builtin.Filesystem.Index.ContentEnabled = boolPtr(false)
		}
		if len(server.Builtin.Filesystem.Index.FileTypes) == 0 {
			server.Builtin.Filesystem.Index.FileTypes = []string{
				".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".toml", ".ini",
				".csv", ".tsv", ".xml", ".html", ".htm", ".go", ".js", ".jsx", ".ts",
				".tsx", ".py", ".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".rs", ".sh",
				".sql", ".css", ".scss", ".less", ".vue", ".svelte", ".php", ".rb",
				".swift", ".kt", ".kts", ".scala", ".dart", ".lua", ".r", ".pl", ".proto",
				"Dockerfile", "Makefile", ".pdf", ".rtf", ".epub",
				".xlsx", ".xlsm", ".xltx", ".xltm", ".xls", ".xlt", ".xla",
				".doc", ".docx", ".docm", ".dotx", ".dotm",
				".ppt", ".pps", ".pot", ".pptx", ".pptm", ".ppsx", ".ppsm", ".potx", ".potm",
				".odt", ".ods", ".odp", ".odg", ".fodt", ".fods", ".fodp",
				".svg", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff",
			}
		}
		if server.Builtin.Filesystem.Index.MaxFileSizeBytes <= 0 {
			server.Builtin.Filesystem.Index.MaxFileSizeBytes = 8 * 1024 * 1024
		}
		if server.Builtin.Filesystem.Index.ParsePDF == nil {
			server.Builtin.Filesystem.Index.ParsePDF = boolPtr(true)
		}
		if server.Builtin.Filesystem.Index.ParseOffice == nil {
			server.Builtin.Filesystem.Index.ParseOffice = boolPtr(true)
		}
		if server.Builtin.Filesystem.Index.ParseImages == nil {
			server.Builtin.Filesystem.Index.ParseImages = boolPtr(true)
		}
	case "chrome":
		if server.Builtin.InstanceID == "" {
			server.Builtin.InstanceID = "chrome_default"
		}
		if server.Builtin.Chrome == nil {
			server.Builtin.Chrome = &BuiltinChromeConfig{}
		}
		if strings.TrimSpace(server.Builtin.Chrome.ConnectionMode) == "" {
			server.Builtin.Chrome.ConnectionMode = "managed"
		}
		if strings.TrimSpace(server.Builtin.Chrome.Channel) == "" {
			server.Builtin.Chrome.Channel = "stable"
		}
		if server.Builtin.Chrome.Headless == nil {
			server.Builtin.Chrome.Headless = boolPtr(false)
		}
		if server.Builtin.Chrome.Isolated == nil {
			server.Builtin.Chrome.Isolated = boolPtr(false)
		}
		if server.Builtin.Chrome.AcceptInsecureCerts == nil {
			server.Builtin.Chrome.AcceptInsecureCerts = boolPtr(false)
		}
		if server.Builtin.Chrome.Slim == nil {
			server.Builtin.Chrome.Slim = boolPtr(true)
		}
		if server.Builtin.Chrome.UsageStatistics == nil {
			server.Builtin.Chrome.UsageStatistics = boolPtr(false)
		}
		if server.Builtin.Chrome.PerformanceCrux == nil {
			server.Builtin.Chrome.PerformanceCrux = boolPtr(false)
		}
		if strings.TrimSpace(server.Builtin.Chrome.UserDataDir) == "" && server.Builtin.Chrome.ConnectionMode == "managed" && (server.Builtin.Chrome.Isolated == nil || !*server.Builtin.Chrome.Isolated) {
			server.Builtin.Chrome.UserDataDir = filepath.Join(DefaultDir(), "browsers", "chrome", server.Builtin.InstanceID, "profile")
		}
	case "commandline":
		if server.Builtin.InstanceID == "" {
			server.Builtin.InstanceID = "commandline_default"
		}
		if server.Builtin.Commandline == nil {
			server.Builtin.Commandline = &BuiltinCommandlineConfig{}
		}
		if server.Builtin.Commandline.MaxTimeoutSec == 0 {
			server.Builtin.Commandline.MaxTimeoutSec = defaultBuiltinCommandlineMaxTimeoutSec
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
		case "filesystem":
			if server.Builtin.Filesystem == nil {
				return fmt.Errorf("builtin.filesystem is required for builtin kind %q", server.Builtin.Kind)
			}
			switch server.Builtin.Filesystem.Scope {
			case "roots":
				if len(server.Builtin.Filesystem.Roots) == 0 {
					return fmt.Errorf("builtin.filesystem.roots must contain at least one root when scope is roots")
				}
			case "global":
				switch server.Builtin.Filesystem.GlobalAccess {
				case "ro", "rw":
				default:
					return fmt.Errorf("builtin.filesystem.global_access must be ro or rw when scope is global")
				}
			default:
				return fmt.Errorf("builtin.filesystem.scope %q is unsupported", server.Builtin.Filesystem.Scope)
			}
			if server.Builtin.Filesystem.MaxGetFileSizeBytes <= 0 {
				return fmt.Errorf("builtin.filesystem.max_get_file_size_bytes must be greater than 0")
			}
			for i, root := range server.Builtin.Filesystem.Roots {
				if strings.TrimSpace(root.Path) == "" {
					return fmt.Errorf("builtin.filesystem.roots[%d].path is required", i)
				}
				switch root.Access {
				case "ro", "rw":
				default:
					return fmt.Errorf("builtin.filesystem.roots[%d].access must be ro or rw", i)
				}
			}
			if server.Builtin.Filesystem.Index.MaxFileSizeBytes <= 0 {
				return fmt.Errorf("builtin.filesystem.index.max_file_size_bytes must be greater than 0")
			}
		case "chrome":
			if server.Builtin.Chrome == nil {
				return fmt.Errorf("builtin.chrome is required for builtin kind %q", server.Builtin.Kind)
			}
			switch server.Builtin.Chrome.ConnectionMode {
			case "managed", "attach_existing", "attach_url":
			default:
				return fmt.Errorf("builtin.chrome.connection_mode %q is unsupported", server.Builtin.Chrome.ConnectionMode)
			}
			switch server.Builtin.Chrome.Channel {
			case "", "stable", "beta", "dev", "canary":
			default:
				return fmt.Errorf("builtin.chrome.channel %q is unsupported", server.Builtin.Chrome.Channel)
			}
			if strings.TrimSpace(server.Builtin.Chrome.BrowserURL) != "" && strings.TrimSpace(server.Builtin.Chrome.WSEndpoint) != "" {
				return fmt.Errorf("builtin.chrome.browser_url and builtin.chrome.ws_endpoint are mutually exclusive")
			}
			switch server.Builtin.Chrome.ConnectionMode {
			case "managed":
				if strings.TrimSpace(server.Builtin.Chrome.BrowserURL) != "" || strings.TrimSpace(server.Builtin.Chrome.WSEndpoint) != "" {
					return fmt.Errorf("builtin.chrome.browser_url and builtin.chrome.ws_endpoint are only valid when connection_mode is attach_url")
				}
			case "attach_existing":
				if strings.TrimSpace(server.Builtin.Chrome.BrowserURL) != "" || strings.TrimSpace(server.Builtin.Chrome.WSEndpoint) != "" {
					return fmt.Errorf("builtin.chrome.browser_url and builtin.chrome.ws_endpoint are not used when connection_mode is attach_existing")
				}
			case "attach_url":
				if strings.TrimSpace(server.Builtin.Chrome.BrowserURL) == "" && strings.TrimSpace(server.Builtin.Chrome.WSEndpoint) == "" {
					return fmt.Errorf("builtin.chrome.browser_url or builtin.chrome.ws_endpoint is required when connection_mode is attach_url")
				}
			}
		case "commandline":
			if server.Builtin.Commandline == nil {
				return fmt.Errorf("builtin.commandline is required for builtin kind %q", server.Builtin.Kind)
			}
			if server.Builtin.Commandline.MaxTimeoutSec <= 0 {
				return fmt.Errorf("builtin.commandline.max_timeout_sec must be greater than 0")
			}
			if server.Builtin.Commandline.MaxTimeoutSec > int64((1<<63-1)/int64(time.Second)) {
				return fmt.Errorf("builtin.commandline.max_timeout_sec is too large")
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
