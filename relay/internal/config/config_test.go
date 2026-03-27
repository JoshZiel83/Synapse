package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateRequiresServerPinForSecureRemoteRelay(t *testing.T) {
	cfg := &Config{
		Relay: RelayConfig{
			ServerBaseURL:  "https://relay.example.com",
			WebSocketURL:   "wss://relay.example.com/ws/relay",
			DeviceID:       "device-123",
			PrivateKeyPath: "/tmp/device-key.pem",
		},
	}

	errs := Validate(cfg)
	found := false
	for _, err := range errs {
		if err == "relay.server_tls_public_key_pin is required for secure remote relay servers" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected missing server TLS pin validation error, got %v", errs)
	}
}

func TestValidateAllowsLoopbackInsecureRelay(t *testing.T) {
	cfg := &Config{
		Relay: RelayConfig{
			ServerBaseURL:         "http://127.0.0.1:3001",
			WebSocketURL:          "ws://127.0.0.1:3001/ws/relay",
			DeviceID:              "device-123",
			PrivateKeyPath:        "/tmp/device-key.pem",
			ServerTLSPublicKeyPin: "",
		},
	}

	for _, err := range Validate(cfg) {
		if err == "relay.server_tls_public_key_pin is required for secure remote relay servers" {
			t.Fatalf("did not expect TLS pin validation for loopback relay")
		}
	}
}

func TestValidateRejectsUnsupportedCloseBehavior(t *testing.T) {
	cfg := &Config{
		Relay: RelayConfig{
			ServerBaseURL:         "http://127.0.0.1:3001",
			WebSocketURL:          "ws://127.0.0.1:3001/ws/relay",
			DeviceID:              "device-123",
			PrivateKeyPath:        "/tmp/device-key.pem",
			ServerTLSPublicKeyPin: "",
		},
		Startup: StartupConfig{
			CloseBehavior: "snooze",
		},
	}

	errs := Validate(cfg)
	found := false
	for _, err := range errs {
		if err == `startup.close_behavior "snooze" is unsupported` {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected close behavior validation error, got %v", errs)
	}
}

func TestNormalizeServerBaseURLAndDeriveWebSocketURL(t *testing.T) {
	base := NormalizeServerBaseURL("https://relay.example.com/dashboard/plugins?relayPairing=abc#fragment")
	if base != "https://relay.example.com" {
		t.Fatalf("expected normalized base URL, got %q", base)
	}

	wsURL := DeriveWebSocketURL("https://relay.example.com/dashboard/plugins?relayPairing=abc#fragment")
	if wsURL != "wss://relay.example.com/ws/relay" {
		t.Fatalf("expected derived websocket URL, got %q", wsURL)
	}
}

func TestValidateBuiltinCUAServer(t *testing.T) {
	cfg := &Config{
		Relay: RelayConfig{
			ServerBaseURL:         "http://127.0.0.1:3001",
			WebSocketURL:          "ws://127.0.0.1:3001/ws/relay",
			DeviceID:              "device-123",
			PrivateKeyPath:        "/tmp/device-key.pem",
			ServerTLSPublicKeyPin: "",
		},
		Servers: []ServerConfig{
			{
				Name:      "computer-use",
				Transport: "builtin",
				Builtin: &BuiltinServerConfig{
					Kind:       "cua",
					InstanceID: "cua_default",
					CUA: &BuiltinCUAConfig{
						ReadOnly:         boolPtr(true),
						ImageSize:        [2]int{1280, 800},
						RelativeSize:     [2]int{1000, 1000},
						ScrollMultiplier: 1,
						DisplaySelector: BuiltinDisplaySelectorConfig{
							Mode: "main",
						},
					},
				},
			},
		},
	}

	if errs := Validate(cfg); len(errs) != 0 {
		t.Fatalf("expected builtin CUA config to validate, got %v", errs)
	}
}

func TestStableKeyForBuiltinIgnoresDisplayName(t *testing.T) {
	first := StableKeyForServer(ServerConfig{
		Name:      "computer-use",
		Transport: "builtin",
		Builtin: &BuiltinServerConfig{
			Kind:       "cua",
			InstanceID: "cua_default",
		},
	})
	second := StableKeyForServer(ServerConfig{
		Name:      "desktop-tools",
		Transport: "builtin",
		Builtin: &BuiltinServerConfig{
			Kind:       "cua",
			InstanceID: "cua_default",
		},
	})

	if first != second {
		t.Fatalf("expected builtin stable key to ignore display name, got %q and %q", first, second)
	}
}

func TestValidateBuiltinFilesystemServer(t *testing.T) {
	cfg := &Config{
		Relay: RelayConfig{
			ServerBaseURL:         "http://127.0.0.1:3001",
			WebSocketURL:          "ws://127.0.0.1:3001/ws/relay",
			DeviceID:              "device-123",
			PrivateKeyPath:        "/tmp/device-key.pem",
			ServerTLSPublicKeyPin: "",
		},
		Servers: []ServerConfig{
			{
				Name:      "filesystem",
				Transport: "builtin",
				Builtin: &BuiltinServerConfig{
					Kind:       "filesystem",
					InstanceID: "filesystem_default",
					Filesystem: &BuiltinFilesystemConfig{
						ReadOnly:            boolPtr(true),
						Scope:               "roots",
						MaxGetFileSizeBytes: 4096,
						Roots: []BuiltinFilesystemRootConfig{
							{Path: "/tmp", Access: "ro"},
						},
						Index: BuiltinFilesystemIndexConfig{
							ContentEnabled:   boolPtr(true),
							FileTypes:        []string{".go", ".md", ".pdf"},
							MaxFileSizeBytes: 1024,
							ParsePDF:         boolPtr(true),
							ParseOffice:      boolPtr(true),
						},
					},
				},
			},
		},
	}

	if errs := Validate(cfg); len(errs) != 0 {
		t.Fatalf("expected builtin filesystem config to validate, got %v", errs)
	}
}

func TestValidateBuiltinFilesystemServerRejectsNonPositiveMaxGetFileSize(t *testing.T) {
	cfg := &Config{
		Relay: RelayConfig{
			ServerBaseURL:         "http://127.0.0.1:3001",
			WebSocketURL:          "ws://127.0.0.1:3001/ws/relay",
			DeviceID:              "device-123",
			PrivateKeyPath:        "/tmp/device-key.pem",
			ServerTLSPublicKeyPin: "",
		},
		Servers: []ServerConfig{
			{
				Name:      "filesystem",
				Transport: "builtin",
				Builtin: &BuiltinServerConfig{
					Kind:       "filesystem",
					InstanceID: "filesystem_default",
					Filesystem: &BuiltinFilesystemConfig{
						Scope:               "roots",
						MaxGetFileSizeBytes: -1,
						Roots: []BuiltinFilesystemRootConfig{
							{Path: "/tmp", Access: "ro"},
						},
						Index: BuiltinFilesystemIndexConfig{
							MaxFileSizeBytes: 1024,
						},
					},
				},
			},
		},
	}

	errs := Validate(cfg)
	found := false
	for _, err := range errs {
		if err == `server "filesystem": builtin.filesystem.max_get_file_size_bytes must be greater than 0` {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected max_get_file_size_bytes validation error, got %v", errs)
	}
}

func TestValidateSkipsDisabledInvalidBuiltinFilesystemServer(t *testing.T) {
	cfg := &Config{
		Relay: RelayConfig{
			ServerBaseURL:         "http://127.0.0.1:3001",
			WebSocketURL:          "ws://127.0.0.1:3001/ws/relay",
			DeviceID:              "device-123",
			PrivateKeyPath:        "/tmp/device-key.pem",
			ServerTLSPublicKeyPin: "",
		},
		Servers: []ServerConfig{
			{
				Name:      "filesystem",
				Enabled:   boolPtr(false),
				Transport: "builtin",
				Builtin: &BuiltinServerConfig{
					Kind:       "filesystem",
					InstanceID: "filesystem_default",
					Filesystem: &BuiltinFilesystemConfig{
						Scope: "roots",
						Roots: []BuiltinFilesystemRootConfig{
							{Path: "", Access: "ro"},
						},
						Index: BuiltinFilesystemIndexConfig{
							MaxFileSizeBytes: 1024,
						},
					},
				},
			},
		},
	}

	if errs := Validate(cfg); len(errs) != 0 {
		t.Fatalf("expected disabled invalid filesystem config to be ignored, got %v", errs)
	}
}

func TestLoadAllowsDisabledInvalidBuiltinFilesystemServer(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	data := []byte(`
servers:
  - name: filesystem
    enabled: false
    transport: builtin
    builtin:
      kind: filesystem
      instance_id: filesystem_default
      filesystem:
        scope: roots
        roots:
          - path: ""
            access: ro
`)

	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("expected disabled invalid filesystem config to load, got %v", err)
	}
	if len(cfg.Servers) != 1 || cfg.Servers[0].Name != "filesystem" {
		t.Fatalf("expected filesystem server to load, got %+v", cfg.Servers)
	}
}

func TestLoadAppliesDefaultBuiltinFilesystemMaxGetFileSize(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	data := []byte(`
servers:
  - name: filesystem
    transport: builtin
    builtin:
      kind: filesystem
      filesystem:
        scope: roots
        roots:
          - path: "/tmp"
            access: ro
`)

	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if len(cfg.Servers) != 1 || cfg.Servers[0].Builtin == nil || cfg.Servers[0].Builtin.Filesystem == nil {
		t.Fatalf("expected filesystem builtin config, got %+v", cfg.Servers)
	}
	if cfg.Servers[0].Builtin.Filesystem.MaxGetFileSizeBytes != defaultBuiltinFilesystemMaxGetFileSizeBytes {
		t.Fatalf("expected default max get file size %d, got %d", defaultBuiltinFilesystemMaxGetFileSizeBytes, cfg.Servers[0].Builtin.Filesystem.MaxGetFileSizeBytes)
	}
}

func TestValidateBuiltinChromeServer(t *testing.T) {
	cfg := &Config{
		Relay: RelayConfig{
			ServerBaseURL:         "http://127.0.0.1:3001",
			WebSocketURL:          "ws://127.0.0.1:3001/ws/relay",
			DeviceID:              "device-123",
			PrivateKeyPath:        "/tmp/device-key.pem",
			ServerTLSPublicKeyPin: "",
		},
		Servers: []ServerConfig{
			{
				Name:      "chrome-browser",
				Transport: "builtin",
				Builtin: &BuiltinServerConfig{
					Kind:       "chrome",
					InstanceID: "chrome_default",
					Chrome: &BuiltinChromeConfig{
						ConnectionMode:  "managed",
						Channel:         "stable",
						UserDataDir:     "/tmp/chrome-profile",
						Headless:        boolPtr(false),
						Isolated:        boolPtr(false),
						Slim:            boolPtr(false),
						UsageStatistics: boolPtr(false),
						PerformanceCrux: boolPtr(false),
					},
				},
			},
		},
	}

	if errs := Validate(cfg); len(errs) != 0 {
		t.Fatalf("expected builtin chrome config to validate, got %v", errs)
	}
}

func TestValidateBuiltinCommandlineServer(t *testing.T) {
	cfg := &Config{
		Relay: RelayConfig{
			ServerBaseURL:         "http://127.0.0.1:3001",
			WebSocketURL:          "ws://127.0.0.1:3001/ws/relay",
			DeviceID:              "device-123",
			PrivateKeyPath:        "/tmp/device-key.pem",
			ServerTLSPublicKeyPin: "",
		},
		Servers: []ServerConfig{
			{
				Name:      "command-line",
				Transport: "builtin",
				Builtin: &BuiltinServerConfig{
					Kind:       "commandline",
					InstanceID: "commandline_default",
					Commandline: &BuiltinCommandlineConfig{
						DefaultCWD:    "/tmp",
						MaxTimeoutSec: 120,
					},
				},
			},
		},
	}

	if errs := Validate(cfg); len(errs) != 0 {
		t.Fatalf("expected builtin commandline config to validate, got %v", errs)
	}
}

func TestValidateBuiltinCommandlineServerRejectsNegativeMaxTimeout(t *testing.T) {
	cfg := &Config{
		Relay: RelayConfig{
			ServerBaseURL:         "http://127.0.0.1:3001",
			WebSocketURL:          "ws://127.0.0.1:3001/ws/relay",
			DeviceID:              "device-123",
			PrivateKeyPath:        "/tmp/device-key.pem",
			ServerTLSPublicKeyPin: "",
		},
		Servers: []ServerConfig{
			{
				Name:      "command-line",
				Transport: "builtin",
				Builtin: &BuiltinServerConfig{
					Kind:       "commandline",
					InstanceID: "commandline_default",
					Commandline: &BuiltinCommandlineConfig{
						MaxTimeoutSec: -1,
					},
				},
			},
		},
	}

	errs := Validate(cfg)
	if len(errs) == 0 {
		t.Fatalf("expected validation errors for negative commandline max timeout")
	}
}

func TestNormalizeSyncMode(t *testing.T) {
	cases := map[string]string{
		"":            SyncModeFollow,
		"follow":      SyncModeFollow,
		"observe":     SyncModeFollow,
		"mirror":      SyncModeFollow,
		"managed":     SyncModeFollow,
		"snapshot":    SyncModeSnapshot,
		"import_only": SyncModeSnapshot,
		"detached":    SyncModeSnapshot,
		"weird":       SyncModeFollow,
	}

	for input, expected := range cases {
		if got := NormalizeSyncMode(input); got != expected {
			t.Fatalf("NormalizeSyncMode(%q) = %q, want %q", input, got, expected)
		}
	}
}
