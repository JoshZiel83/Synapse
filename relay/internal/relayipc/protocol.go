package relayipc

import "encoding/json"

const jsonRPCVersion = "2.0"

type Message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      string          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

type HelloParams struct {
	Token       string `json:"token"`
	HostKind    string `json:"hostKind"`
	HostVersion string `json:"hostVersion"`
	ProfileID   string `json:"profileId"`
}

type HelloResult struct {
	AgentVersion string `json:"agentVersion"`
	ProfileID    string `json:"profileId"`
}
