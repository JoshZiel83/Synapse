package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// HTTPServer manages a remote MCP server over HTTP
type HTTPServer struct {
	endpoint  string
	sessionID string
	client    *http.Client

	mu    sync.Mutex
	idSeq int32
	tools []Tool
}

func NewHTTPServer(endpoint string) *HTTPServer {
	return &HTTPServer{
		endpoint: endpoint,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (h *HTTPServer) Start(ctx context.Context) error {
	// No-op for HTTP — connection is stateless
	return nil
}

func (h *HTTPServer) Initialize() error {
	h.mu.Lock()
	defer h.mu.Unlock()

	id := int(atomic.AddInt32(&h.idSeq, 1))
	req := InitializeRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "initialize",
		Params: map[string]interface{}{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]interface{}{},
			"clientInfo": map[string]interface{}{
				"name":    "synapse-relay",
				"version": "1.0.0",
			},
		},
	}

	var result InitializeResult
	if err := h.doRequest(req, &result); err != nil {
		return err
	}

	if result.Error != nil {
		return fmt.Errorf("initialize error: %s", result.Error.Message)
	}

	// Send initialized notification
	notif := NotificationMessage{
		JSONRPC: "2.0",
		Method:  "notifications/initialized",
	}
	h.doRequest(notif, nil) // ignore response for notifications

	return nil
}

func (h *HTTPServer) ListTools() ([]Tool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	id := int(atomic.AddInt32(&h.idSeq, 1))
	req := ToolsListRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "tools/list",
	}

	var result ToolsListResult
	if err := h.doRequest(req, &result); err != nil {
		return nil, err
	}

	if result.Error != nil {
		return nil, fmt.Errorf("tools/list error: %s", result.Error.Message)
	}

	for i, t := range result.Result.Tools {
		if t.InputSchema != nil && t.Parameters == nil {
			result.Result.Tools[i].Parameters = t.InputSchema
		}
	}

	h.tools = result.Result.Tools
	return result.Result.Tools, nil
}

func (h *HTTPServer) CallTool(ctx context.Context, toolName string, args map[string]interface{}) (interface{}, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	id := int(atomic.AddInt32(&h.idSeq, 1))
	req := ToolCallRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "tools/call",
	}
	req.Params.Name = toolName
	req.Params.Arguments = args

	var result ToolCallResult
	if err := h.doRequest(req, &result); err != nil {
		return nil, err
	}

	if result.Error != nil {
		return nil, fmt.Errorf("tools/call error: %s", result.Error.Message)
	}

	return map[string]interface{}{
		"content": result.Result.Content,
		"isError": result.Result.IsError,
	}, nil
}

func (h *HTTPServer) Shutdown() {
	// No-op for HTTP
}

func (h *HTTPServer) doRequest(body interface{}, target interface{}) error {
	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	httpReq, err := http.NewRequest("POST", h.endpoint, bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json, text/event-stream")
	if h.sessionID != "" {
		httpReq.Header.Set("Mcp-Session-Id", h.sessionID)
	}

	resp, err := h.client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	// Track session ID
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		h.sessionID = sid
	}

	if target == nil {
		io.Copy(io.Discard, resp.Body)
		return nil
	}

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(bodyBytes))
	}

	// Check content type — could be JSON or SSE
	ct := resp.Header.Get("Content-Type")
	if ct == "text/event-stream" || ct == "text/event-stream; charset=utf-8" {
		return h.parseSSEResponse(resp.Body, target)
	}

	return json.NewDecoder(resp.Body).Decode(target)
}

func (h *HTTPServer) parseSSEResponse(reader io.Reader, target interface{}) error {
	scanner := json.NewDecoder(reader)
	// For SSE, we look for the first complete JSON message
	// This is a simplified SSE parser
	buf := make([]byte, 0, 4096)
	rawBuf := make([]byte, 1024)

	for {
		n, err := reader.Read(rawBuf)
		if n > 0 {
			buf = append(buf, rawBuf[:n]...)
			// Try to find "data: " lines and parse JSON
			for {
				idx := bytes.IndexByte(buf, '\n')
				if idx == -1 {
					break
				}
				line := buf[:idx]
				buf = buf[idx+1:]

				if len(line) > 6 && string(line[:6]) == "data: " {
					jsonData := line[6:]
					if err := json.Unmarshal(jsonData, target); err == nil {
						return nil
					}
				}
			}
		}
		if err != nil {
			break
		}
	}

	_ = scanner // suppress unused
	return fmt.Errorf("no valid JSON-RPC response in SSE stream")
}
