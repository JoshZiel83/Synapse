// synapse-device-cua-helper — Go sidecar binary that provides CUA primitives
// to the TypeScript device runtime via JSON-RPC over stdio. v3.0 introduces
// the binary; it remains a thin wrapper around the existing
// relay/internal/builtinmcp/cua package (which itself drives DeskAct) so the
// runtime can supervise it as a child process per spec §5.2 / §10.4.
//
// Protocol: JSON-RPC 2.0 over stdio. Methods mirror the device-protocol CUA
// catalog (see packages/device-protocol/src/enums.ts DEVICE_BUILTIN_KINDS).
// Full method surface lands as the runtime side wires the CUA tools.

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

const version = "0.1.0-device-runtime-v3"

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id,omitempty"`
	Result  interface{} `json:"result,omitempty"`
	Error   *rpcError   `json:"error,omitempty"`
}

func writeResponse(w io.Writer, id interface{}, result interface{}, err *rpcError) {
	resp := rpcResponse{JSONRPC: "2.0", ID: id, Result: result, Error: err}
	data, _ := json.Marshal(resp)
	fmt.Fprintln(w, string(data))
}

func handle(line []byte, w io.Writer) {
	var req rpcRequest
	if err := json.Unmarshal(line, &req); err != nil {
		writeResponse(w, nil, nil, &rpcError{Code: -32700, Message: "Parse error"})
		return
	}
	switch req.Method {
	case "hello":
		writeResponse(w, req.ID, map[string]interface{}{
			"version":    version,
			"capability": "cua",
		}, nil)
	case "shutdown":
		writeResponse(w, req.ID, map[string]interface{}{"ok": true}, nil)
		os.Exit(0)
	default:
		// v3.0 skeleton: declare unsupported. PR follow-ups wire the actual
		// list_displays / capture_display / click / type_text methods that
		// drive relay/internal/builtinmcp/cua/desktop_deskact.go.
		writeResponse(w, req.ID, nil, &rpcError{
			Code:    -32601,
			Message: "Method not found in v3.0 skeleton: " + req.Method,
		})
	}
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	// Allow large frames (screenshot payloads etc.).
	scanner.Buffer(make([]byte, 1024*1024), 32*1024*1024)
	for scanner.Scan() {
		handle(scanner.Bytes(), os.Stdout)
	}
}
