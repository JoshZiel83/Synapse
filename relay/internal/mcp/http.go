package mcp

import (
	"bufio"
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

const httpRequestTimeout = 30 * time.Second

// HTTPServer manages a remote MCP server over HTTP
type HTTPServer struct {
	endpoint  string
	sessionID string
	client    *http.Client

	mu    sync.Mutex
	idSeq int32
	tools []Tool

	sessionMu          sync.RWMutex
	onToolsListChanged func()
	streamCtx          context.Context
	streamCancel       context.CancelFunc
	streamActive       bool
	streamUnsupported  bool
}

func NewHTTPServer(endpoint string) *HTTPServer {
	return &HTTPServer{
		endpoint: endpoint,
		client:   &http.Client{},
	}
}

func (h *HTTPServer) Start(ctx context.Context) error {
	h.sessionMu.Lock()
	defer h.sessionMu.Unlock()

	if h.streamCancel != nil {
		h.streamCancel()
	}
	h.streamCtx, h.streamCancel = context.WithCancel(ctx)
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
	if err := h.doRequest(context.Background(), req, &result); err != nil {
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
	h.doRequest(context.Background(), notif, nil) // ignore response for notifications
	h.ensureEventStream()

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
	if err := h.doRequest(context.Background(), req, &result); err != nil {
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
	h.ensureEventStream()
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
	if err := h.doRequest(ctx, req, &result); err != nil {
		return nil, err
	}

	if result.Error != nil {
		return nil, fmt.Errorf("tools/call error: %s", result.Error.Message)
	}

	h.ensureEventStream()
	return map[string]interface{}{
		"content": result.Result.Content,
		"isError": result.Result.IsError,
	}, nil
}

func (h *HTTPServer) Shutdown() {
	h.sessionMu.Lock()
	defer h.sessionMu.Unlock()
	if h.streamCancel != nil {
		h.streamCancel()
		h.streamCancel = nil
	}
	h.streamCtx = nil
	h.streamActive = false
}

func (h *HTTPServer) SetToolsChangedHandler(handler func()) {
	h.sessionMu.Lock()
	h.onToolsListChanged = handler
	h.sessionMu.Unlock()
	h.ensureEventStream()
}

func (h *HTTPServer) doRequest(ctx context.Context, body interface{}, target interface{}) error {
	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	if ctx == nil {
		ctx = context.Background()
	}
	reqCtx, cancel := context.WithTimeout(ctx, httpRequestTimeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(reqCtx, "POST", h.endpoint, bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json, text/event-stream")
	if sid := h.getSessionID(); sid != "" {
		httpReq.Header.Set("Mcp-Session-Id", sid)
	}

	resp, err := h.client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	// Track session ID
	h.setSessionID(resp.Header.Get("Mcp-Session-Id"))

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
		return h.parseSSEStream(resp.Body, target)
	}

	return json.NewDecoder(resp.Body).Decode(target)
}

func (h *HTTPServer) ensureEventStream() {
	h.sessionMu.Lock()
	defer h.sessionMu.Unlock()

	if h.streamUnsupported || h.streamActive || h.streamCtx == nil || h.onToolsListChanged == nil || h.sessionID == "" {
		return
	}

	ctx := h.streamCtx
	h.streamActive = true
	go h.runEventStream(ctx)
}

func (h *HTTPServer) runEventStream(ctx context.Context) {
	defer func() {
		h.sessionMu.Lock()
		h.streamActive = false
		h.sessionMu.Unlock()
	}()

	backoff := time.Second
	for {
		unsupported, err := h.connectEventStream(ctx)
		if unsupported {
			h.sessionMu.Lock()
			h.streamUnsupported = true
			h.sessionMu.Unlock()
			return
		}
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			backoff = time.Second
		}

		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 15*time.Second {
			backoff *= 2
			if backoff > 15*time.Second {
				backoff = 15 * time.Second
			}
		}
	}
}

func (h *HTTPServer) connectEventStream(ctx context.Context) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.endpoint, nil)
	if err != nil {
		return false, fmt.Errorf("create event stream request: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	if sid := h.getSessionID(); sid != "" {
		req.Header.Set("Mcp-Session-Id", sid)
	}

	resp, err := h.client.Do(req)
	if err != nil {
		return false, fmt.Errorf("open event stream: %w", err)
	}
	defer resp.Body.Close()

	h.setSessionID(resp.Header.Get("Mcp-Session-Id"))

	if resp.StatusCode == http.StatusMethodNotAllowed ||
		resp.StatusCode == http.StatusNotFound ||
		resp.StatusCode == http.StatusNotAcceptable {
		return true, nil
	}
	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return false, fmt.Errorf("event stream HTTP %d: %s", resp.StatusCode, string(bodyBytes))
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" && ct != "text/event-stream; charset=utf-8" {
		return true, nil
	}

	if err := h.parseSSEStream(resp.Body, nil); err != nil && ctx.Err() == nil {
		return false, err
	}
	return false, nil
}

func (h *HTTPServer) parseSSEStream(reader io.Reader, target interface{}) error {
	br := bufio.NewReader(reader)
	var dataLines [][]byte
	responseReceived := false

	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			line = bytes.TrimRight(line, "\r\n")
			if len(line) == 0 {
				if len(dataLines) > 0 {
					payload := bytes.Join(dataLines, []byte("\n"))
					dataLines = dataLines[:0]
					if h.handleEventPayload(payload, target, &responseReceived) && target != nil && responseReceived {
						return nil
					}
				}
			} else if bytes.HasPrefix(line, []byte("data:")) {
				data := bytes.TrimSpace(line[len("data:"):])
				dataLines = append(dataLines, append([]byte(nil), data...))
			}
		}

		if err != nil {
			if err == io.EOF {
				if len(dataLines) > 0 {
					payload := bytes.Join(dataLines, []byte("\n"))
					if h.handleEventPayload(payload, target, &responseReceived) && target != nil && responseReceived {
						return nil
					}
				}
				if target != nil && responseReceived {
					return nil
				}
			}
			if err == io.EOF {
				return err
			}
			return fmt.Errorf("read SSE stream: %w", err)
		}
	}
}

func (h *HTTPServer) handleEventPayload(payload []byte, target interface{}, responseReceived *bool) bool {
	var msg struct {
		Method string          `json:"method"`
		ID     json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return false
	}

	if msg.Method != "" && len(msg.ID) == 0 {
		if msg.Method == "notifications/tools/list_changed" {
			h.sessionMu.RLock()
			handler := h.onToolsListChanged
			h.sessionMu.RUnlock()
			if handler != nil {
				handler()
			}
		}
		return true
	}

	if target == nil {
		return false
	}
	if err := json.Unmarshal(payload, target); err != nil {
		return false
	}
	*responseReceived = true
	return true
}

func (h *HTTPServer) getSessionID() string {
	h.sessionMu.RLock()
	defer h.sessionMu.RUnlock()
	return h.sessionID
}

func (h *HTTPServer) setSessionID(sessionID string) {
	if sessionID == "" {
		return
	}
	h.sessionMu.Lock()
	h.sessionID = sessionID
	h.sessionMu.Unlock()
}

func (h *HTTPServer) parseSSEResponse(reader io.Reader, target interface{}) error {
	// Backward-compatible wrapper for older callers/tests.
	return h.parseSSEStream(reader, target)
}
