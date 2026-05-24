package cloud

import "github.com/PekingSpades/Synapse/relay/internal/runtimeauth"

// Relay WebSocket protocol v2

const RelayProtocolVersion = 2

type AuthBeginMessage struct {
	Type                 string `json:"type"`
	DeviceID             string `json:"deviceId"`
	PublicKeyFingerprint string `json:"publicKeyFingerprint,omitempty"`
	ProtocolVersion      int    `json:"protocolVersion"`
	ClientVersion        string `json:"clientVersion,omitempty"`
}

type AuthChallengeMessage struct {
	Type      string `json:"type"`
	DeviceID  string `json:"deviceId"`
	Challenge string `json:"challenge"`
	Nonce     string `json:"nonce"`
}

type AuthFinishMessage struct {
	Type      string `json:"type"`
	DeviceID  string `json:"deviceId"`
	Challenge string `json:"challenge"`
	Signature string `json:"signature"`
}

type AuthOKMessage struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	DeviceID        string `json:"deviceId"`
	SessionID       string `json:"sessionId"`
}

type AuthErrorMessage struct {
	Type      string `json:"type"`
	Code      string `json:"code,omitempty"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type CatalogSyncMessage struct {
	Type        string      `json:"type"`
	SyncSources interface{} `json:"syncSources,omitempty"`
	Exposures   interface{} `json:"exposures"`
}

type CatalogSyncedMessage struct {
	Type          string `json:"type"`
	ExposureCount int    `json:"exposureCount"`
}

type PingMessage struct {
	Type string `json:"type"`
}

type PongMessage struct {
	Type string `json:"type"`
}

type RelayDispatchMessage struct {
	Type            string               `json:"type"`
	ProtocolVersion int                  `json:"protocolVersion"`
	SessionID       string               `json:"sessionId"`
	OperationID     string               `json:"operationId"`
	DeliveryID      string               `json:"deliveryId"`
	Payload         RelayDispatchPayload `json:"payload"`
}

type RelayDispatchPayload struct {
	ExposureID        string                            `json:"exposureId"`
	ExposureStableKey string                            `json:"exposureStableKey"`
	RuntimeSessionID  string                            `json:"runtimeSessionId,omitempty"`
	ToolID            string                            `json:"toolId"`
	ToolRevisionID    string                            `json:"toolRevisionId"`
	ToolName          string                            `json:"toolName"`
	ResponseMode      string                            `json:"responseMode,omitempty"`
	InputHash         string                            `json:"inputHash"`
	Arguments         map[string]interface{}            `json:"arguments"`
	Authorization     *RelayRuntimeAuthorizationPayload `json:"authorization,omitempty"`
	ExpiresInMs       int                               `json:"expiresInMs"`
}

type RelayRuntimeAuthorizationPayload struct {
	GrantIDs   []string `json:"grantIds,omitempty"`
	GrantScope string   `json:"grantScope,omitempty"`
	// P4 contract: strongly-typed GrantPolicy values on the wire, replacing
	// the historical `[]map[string]interface{}` indirection.
	GrantSpecs []runtimeauth.GrantPolicy `json:"grantSpecs,omitempty"`
	RetryNonce string                    `json:"retryNonce,omitempty"`
}

type RelayRuntimeSessionOpenMessage struct {
	Type             string                         `json:"type"`
	ProtocolVersion  int                            `json:"protocolVersion"`
	SessionID        string                         `json:"sessionId"`
	RuntimeSessionID string                         `json:"runtimeSessionId"`
	DeliveryID       string                         `json:"deliveryId"`
	Payload          RelayRuntimeSessionOpenPayload `json:"payload"`
}

type RelayRuntimeSessionOpenPayload struct {
	ExposureID        string `json:"exposureId"`
	ExposureStableKey string `json:"exposureStableKey"`
}

type RelayRuntimeSessionCloseMessage struct {
	Type             string `json:"type"`
	ProtocolVersion  int    `json:"protocolVersion"`
	SessionID        string `json:"sessionId"`
	RuntimeSessionID string `json:"runtimeSessionId"`
	DeliveryID       string `json:"deliveryId"`
}

type RelayCUATerminateMessage struct {
	Type             string `json:"type"`
	ProtocolVersion  int    `json:"protocolVersion"`
	SessionID        string `json:"sessionId"`
	RuntimeSessionID string `json:"runtimeSessionId"`
	Reason           string `json:"reason"`
}

type OperationReceivedMessage struct {
	Type        string `json:"type"`
	OperationID string `json:"operationId"`
	DeliveryID  string `json:"deliveryId,omitempty"`
}

type OperationStartedMessage struct {
	Type        string `json:"type"`
	OperationID string `json:"operationId"`
	DeliveryID  string `json:"deliveryId,omitempty"`
}

type OperationOutputMessage struct {
	Type        string `json:"type"`
	OperationID string `json:"operationId"`
	DeliveryID  string `json:"deliveryId,omitempty"`
	Seq         int64  `json:"seq"`
	Stream      string `json:"stream"`
	Text        string `json:"text"`
	CreatedAt   string `json:"createdAt,omitempty"`
}

type OperationResultMessage struct {
	Type        string               `json:"type"`
	OperationID string               `json:"operationId"`
	DeliveryID  string               `json:"deliveryId,omitempty"`
	Success     bool                 `json:"success"`
	Result      interface{}          `json:"result,omitempty"`
	Error       *RelayOperationError `json:"error,omitempty"`
}

type RelayOperationCancelMessage struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	SessionID       string `json:"sessionId"`
	OperationID     string `json:"operationId"`
	DeliveryID      string `json:"deliveryId"`
	Reason          string `json:"reason,omitempty"`
}

type RuntimeSessionResultMessage struct {
	Type             string               `json:"type"`
	Action           string               `json:"action"`
	RuntimeSessionID string               `json:"runtimeSessionId"`
	DeliveryID       string               `json:"deliveryId,omitempty"`
	Success          bool                 `json:"success"`
	Error            *RelayOperationError `json:"error,omitempty"`
}

type RelayOperationError struct {
	Code                string `json:"code"`
	Message             string `json:"message"`
	Retryable           bool   `json:"retryable"`
	RequiresReplan      bool   `json:"requiresReplan,omitempty"`
	CurrentToolRevision string `json:"currentToolRevisionId,omitempty"`
}

type GenericMessage struct {
	Type      string `json:"type,omitempty"`
	DeviceID  string `json:"deviceId,omitempty"`
	Challenge string `json:"challenge,omitempty"`
}
