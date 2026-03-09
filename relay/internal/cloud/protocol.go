package cloud

// Message types for the cloud<->agent WebSocket protocol

// Auth messages
type AuthMessage struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

type AuthOKMessage struct {
	Type    string `json:"type"`
	RelayID string `json:"relayId"`
}

type AuthErrorMessage struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// Server registration
type ServersRegisterMessage struct {
	Type    string      `json:"type"`
	Servers interface{} `json:"servers"` // accepts []mcp.ServerInfo
}

// Heartbeat
type PingMessage struct {
	Type string `json:"type"`
}

type PongMessage struct {
	Type string `json:"type"`
}

// JSON-RPC 2.0 messages
type JSONRPCRequest struct {
	JSONRPC string                 `json:"jsonrpc"`
	ID      string                 `json:"id"`
	Method  string                 `json:"method"`
	Params  map[string]interface{} `json:"params"`
}

type JSONRPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      string      `json:"id"`
	Result  interface{} `json:"result,omitempty"`
	Error   *RPCError   `json:"error,omitempty"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Generic message for type detection
type GenericMessage struct {
	Type    string `json:"type,omitempty"`
	JSONRPC string `json:"jsonrpc,omitempty"`
	ID      string `json:"id,omitempty"`
	Method  string `json:"method,omitempty"`
}
