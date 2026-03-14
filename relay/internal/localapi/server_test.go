package localapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandlePairingRejectsMismatchedOrigin(t *testing.T) {
	called := false
	server := New(DefaultPort, "test", func(serverBaseURL, pairingCode, displayName string) bool {
		called = true
		return true
	}, nil)

	req := httptest.NewRequest(http.MethodPost, "/pairing", bytes.NewBufferString(`{"serverBaseUrl":"https://synapse.example","pairingCode":"PAIR-1234"}`))
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.handlePairing(recorder, req)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for mismatched origin, got %d", recorder.Code)
	}
	if called {
		t.Fatalf("expected pairing handler not to be called")
	}

	var payload PairingResponse
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Accepted {
		t.Fatalf("expected pairing to be rejected")
	}
}

func TestHandlePairingAllowsMatchingOrigin(t *testing.T) {
	called := false
	server := New(DefaultPort, "test", func(serverBaseURL, pairingCode, displayName string) bool {
		called = serverBaseURL == "https://synapse.example" && pairingCode == "PAIR-1234"
		return true
	}, nil)

	req := httptest.NewRequest(http.MethodPost, "/pairing", bytes.NewBufferString(`{"serverBaseUrl":"https://synapse.example","pairingCode":"PAIR-1234"}`))
	req.Header.Set("Origin", "https://synapse.example")
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.handlePairing(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200 for matching origin, got %d", recorder.Code)
	}
	if !called {
		t.Fatalf("expected pairing handler to be called")
	}
}

func TestHandleStatusRedactsSensitiveFieldsForUntrustedOrigin(t *testing.T) {
	server := New(DefaultPort, "test", nil, func() StatusSnapshot {
		return StatusSnapshot{
			Relay:                "running",
			Paired:               true,
			ServerIdentityPinned: true,
			DeviceID:             "device-123",
			DisplayName:          "Relay Desktop",
			ServerBaseURL:        "https://synapse.example",
			WebSocketURL:         "wss://synapse.example/api/v1/mcp/relay/connect",
			PublicKeyFingerprint: "fingerprint-123",
			ServerTLSPublicKeyPin: "sha256:pin",
		}
	})

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	req.Header.Set("Origin", "https://other.example")
	recorder := httptest.NewRecorder()

	server.handleStatus(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", recorder.Code)
	}

	var payload StatusResponse
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.DeviceID != "" || payload.WebSocketURL != "" || payload.PublicKeyFingerprint != "" {
		t.Fatalf("expected sensitive fields to be redacted, got %+v", payload.StatusSnapshot)
	}
	if payload.ServerTLSPublicKeyPin != "" {
		t.Fatalf("expected server TLS pin to be redacted, got %+v", payload.StatusSnapshot)
	}
	if payload.ServerBaseURL != "https://synapse.example" || !payload.Paired {
		t.Fatalf("expected public pairing state to remain visible")
	}
	if !payload.ServerIdentityPinned {
		t.Fatalf("expected public pinned indicator to remain visible")
	}
}

func TestHandleStatusReturnsFullSnapshotForTrustedOrigin(t *testing.T) {
	server := New(DefaultPort, "test", nil, func() StatusSnapshot {
		return StatusSnapshot{
			Relay:                "running",
			Paired:               true,
			ServerIdentityPinned: true,
			DeviceID:             "device-123",
			DisplayName:          "Relay Desktop",
			ServerBaseURL:        "https://synapse.example",
			WebSocketURL:         "wss://synapse.example/api/v1/mcp/relay/connect",
			PublicKeyFingerprint: "fingerprint-123",
			ServerTLSPublicKeyPin: "sha256:pin",
		}
	})

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	req.Header.Set("Origin", "https://synapse.example")
	recorder := httptest.NewRecorder()

	server.handleStatus(recorder, req)

	var payload StatusResponse
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.DeviceID != "device-123" || payload.PublicKeyFingerprint != "fingerprint-123" || payload.ServerTLSPublicKeyPin != "sha256:pin" {
		t.Fatalf("expected trusted origin to receive full snapshot, got %+v", payload.StatusSnapshot)
	}
}
