package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/deviceauth"
)

type PairingClaimResult struct {
	DeviceID              string `json:"deviceId"`
	DisplayName           string `json:"displayName"`
	WorkspaceID           string `json:"workspaceId"`
	ProtocolVersion       int    `json:"protocolVersion"`
	WebSocketURL          string `json:"websocketUrl"`
	ServerBaseURL         string `json:"serverBaseUrl"`
	ServerTLSPublicKeyPin string `json:"serverTlsPublicKeyPin,omitempty"`
}

type pairingClaimErrorResponse struct {
	Error string `json:"error"`
}

func ClaimPairing(ctx context.Context, relayCfg config.RelayConfig, pairingCode, displayName string) (*config.RelayConfig, *PairingClaimResult, error) {
	serverBaseURL := config.NormalizeServerBaseURL(relayCfg.ServerBaseURL)
	if serverBaseURL == "" {
		return nil, nil, fmt.Errorf("server base URL is required")
	}
	if strings.TrimSpace(pairingCode) == "" {
		return nil, nil, fmt.Errorf("pairing code is required")
	}
	resolvedDisplayName := ResolveRelayDisplayName(displayName)

	identity, err := deviceauth.EnsureIdentity(relayCfg.PrivateKeyPath)
	if err != nil {
		return nil, nil, err
	}

	requestBody := map[string]interface{}{
		"pairingCode":          strings.TrimSpace(pairingCode),
		"displayName":          resolvedDisplayName,
		"clientKind":           "desktop",
		"platform":             runtimePlatform(),
		"publicKey":            identity.PublicKeyPEM,
		"publicKeyFingerprint": identity.Fingerprint,
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal pairing request: %w", err)
	}

	if err := validateSecureRelayURL(serverBaseURL); err != nil {
		return nil, nil, err
	}

	capturedServerPin := ""
	transport := http.DefaultTransport.(*http.Transport).Clone()
	tlsConfig, err := buildPinnedTLSConfig(serverBaseURL, "", &capturedServerPin)
	if err != nil {
		return nil, nil, err
	}
	if tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, serverBaseURL+"/api/v1/mcp/relay/pairing/claim", bytes.NewReader(body))
	if err != nil {
		return nil, nil, fmt.Errorf("create pairing request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	httpClient := &http.Client{
		Timeout:   15 * time.Second,
		Transport: transport,
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("claim pairing: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("read pairing response: %w", err)
	}

	if resp.StatusCode >= 400 {
		var errorResponse pairingClaimErrorResponse
		if err := json.Unmarshal(bodyBytes, &errorResponse); err == nil && strings.TrimSpace(errorResponse.Error) != "" {
			return nil, nil, fmt.Errorf("%s", strings.TrimSpace(errorResponse.Error))
		}
		return nil, nil, fmt.Errorf("claim pairing failed with status %d", resp.StatusCode)
	}

	var result PairingClaimResult
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, nil, fmt.Errorf("decode pairing response: %w", err)
	}
	if requiresPinnedServerIdentity(serverBaseURL) && strings.TrimSpace(capturedServerPin) == "" {
		return nil, nil, fmt.Errorf("failed to capture relay server TLS public key pin")
	}

	nextRelay := relayCfg
	nextRelay.ServerBaseURL = serverBaseURL
	nextRelay.WebSocketURL = config.DeriveWebSocketURL(serverBaseURL)
	nextRelay.DeviceID = result.DeviceID
	nextRelay.DisplayName = ResolveRelayDisplayName(result.DisplayName)
	nextRelay.PublicKeyFingerprint = identity.Fingerprint
	nextRelay.PrivateKeyPath = identity.PrivateKeyPath
	nextRelay.ServerTLSPublicKeyPin = capturedServerPin

	result.ServerBaseURL = nextRelay.ServerBaseURL
	result.WebSocketURL = nextRelay.WebSocketURL
	result.DisplayName = nextRelay.DisplayName
	result.ServerTLSPublicKeyPin = capturedServerPin
	return &nextRelay, &result, nil
}

func runtimePlatform() string {
	return strings.TrimSpace(strings.ToLower(runtime.GOOS))
}
