package config

import "testing"

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
