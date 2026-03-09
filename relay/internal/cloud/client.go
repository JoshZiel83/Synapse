package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	maxReconnectDelay   = 60 * time.Second
	baseReconnectDelay  = 1 * time.Second
	reconnectMultiplier = 2.0
	jitterFraction      = 0.25
)

// ErrPermanentAuthFailure is returned when the token is rejected and retrying won't help
var ErrPermanentAuthFailure = errors.New("permanent auth failure — token invalid or revoked")

// disconnectError wraps an error that occurred after a successful connection was established.
// Used to distinguish "failed to connect" from "connected then disconnected" for backoff reset.
type disconnectError struct{ err error }

func (d *disconnectError) Error() string { return d.err.Error() }
func (d *disconnectError) Unwrap() error { return d.err }

// ToolCaller is an interface for dispatching tool calls to local MCP servers
type ToolCaller interface {
	CallTool(ctx context.Context, serverName, toolName string, args map[string]interface{}) (interface{}, error)
}

type Client struct {
	endpoint string
	token    string
	caller   ToolCaller
	servers  interface{} // []mcp.ServerInfo passed opaquely
	mu       sync.Mutex

	// OnEvent is an optional callback for relay events (e.g. for GUI observability).
	// evtType is one of: "connecting", "connected", "disconnected", "auth_failed", "tool_call", "tool_result", "error", "log"
	OnEvent func(evtType string, msg string, data map[string]interface{})
}

func NewClient(endpoint, token string, caller ToolCaller) *Client {
	return &Client{
		endpoint: endpoint,
		token:    token,
		caller:   caller,
	}
}

func (c *Client) emit(evtType, msg string, data map[string]interface{}) {
	if c.OnEvent != nil {
		c.OnEvent(evtType, msg, data)
	}
}

func (c *Client) SetServers(servers interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.servers = servers
}

// Run connects to the cloud and enters the main read loop.
// Reconnects with exponential backoff on disconnection.
// Stops permanently on auth rejection (invalid/revoked token).
func (c *Client) Run(ctx context.Context) error {
	attempt := 0

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		err := c.connectAndServe(ctx)
		if ctx.Err() != nil {
			return nil // graceful shutdown
		}

		// Permanent auth failure — don't retry
		if errors.Is(err, ErrPermanentAuthFailure) {
			log.Printf("Fatal: %v. Not retrying.", err)
			return err
		}

		// If we were successfully connected before disconnect, reset backoff
		var de *disconnectError
		if errors.As(err, &de) {
			attempt = 0
		}

		attempt++
		delay := c.backoffDelay(attempt)
		log.Printf("Disconnected (attempt %d): %v. Reconnecting in %v...", attempt, err, delay)
		c.emit("disconnected", fmt.Sprintf("Disconnected (attempt %d), reconnecting in %v", attempt, delay), nil)

		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
	}
}

func (c *Client) connectAndServe(ctx context.Context) error {
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	c.emit("connecting", fmt.Sprintf("Connecting to %s...", c.endpoint), nil)
	log.Printf("Connecting to %s...", c.endpoint)
	conn, _, err := dialer.DialContext(ctx, c.endpoint, http.Header{})
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	// Authenticate
	authMsg := AuthMessage{Type: "auth", Token: c.token}
	if err := conn.WriteJSON(authMsg); err != nil {
		return fmt.Errorf("send auth: %w", err)
	}

	// Wait for auth response with timeout
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("read auth response: %w", err)
	}
	conn.SetReadDeadline(time.Time{}) // clear deadline

	var generic GenericMessage
	if err := json.Unmarshal(raw, &generic); err != nil {
		return fmt.Errorf("parse auth response: %w", err)
	}

	if generic.Type == "auth_error" {
		var authErr AuthErrorMessage
		json.Unmarshal(raw, &authErr)
		msg := authErr.Message
		c.emit("auth_failed", msg, nil)
		// Permanent failures: invalid token, already connected
		if strings.Contains(msg, "Invalid") || strings.Contains(msg, "unknown") {
			return fmt.Errorf("%w: %s", ErrPermanentAuthFailure, msg)
		}
		return fmt.Errorf("auth rejected: %s", msg)
	}

	if generic.Type != "auth_ok" {
		return fmt.Errorf("unexpected auth response type: %s", generic.Type)
	}

	var authOK AuthOKMessage
	json.Unmarshal(raw, &authOK)
	log.Printf("Authenticated as relay %s", authOK.RelayID)
	c.emit("connected", fmt.Sprintf("Authenticated as relay %s", authOK.RelayID), map[string]interface{}{"relayId": authOK.RelayID})

	// Register servers
	c.mu.Lock()
	servers := c.servers
	c.mu.Unlock()

	regMsg := ServersRegisterMessage{Type: "servers_register", Servers: servers}
	if err := conn.WriteJSON(regMsg); err != nil {
		return fmt.Errorf("send servers_register: %w", err)
	}

	// Wait for registration ack/error
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, raw, err = conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("read registration response: %w", err)
	}
	conn.SetReadDeadline(time.Time{})

	var regResp GenericMessage
	if err := json.Unmarshal(raw, &regResp); err != nil {
		return fmt.Errorf("parse registration response: %w", err)
	}

	if regResp.Type == "servers_register_error" {
		// Parse the error message
		var errMsg struct {
			Message string `json:"message"`
		}
		json.Unmarshal(raw, &errMsg)
		return fmt.Errorf("server registration rejected: %s", errMsg.Message)
	}

	if regResp.Type == "servers_registered" {
		log.Printf("Server registration acknowledged")
	} else {
		log.Printf("Unexpected registration response type: %s (continuing)", regResp.Type)
	}

	log.Printf("Connected and ready")

	// Main read loop — connection is established.
	// Wrap readLoop errors as disconnectError to signal successful connection (reset backoff).
	if err := c.readLoop(ctx, conn); err != nil {
		return &disconnectError{err: err}
	}
	return &disconnectError{err: fmt.Errorf("read loop ended")}
}

func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) error {
	// Write mutex for concurrent writes
	var writeMu sync.Mutex

	// Close connection when context is cancelled
	go func() {
		<-ctx.Done()
		conn.Close()
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}

		var generic GenericMessage
		if err := json.Unmarshal(raw, &generic); err != nil {
			log.Printf("Failed to parse message: %v", err)
			continue
		}

		// Handle ping
		if generic.Type == "ping" {
			writeMu.Lock()
			if err := conn.WriteJSON(PongMessage{Type: "pong"}); err != nil {
				writeMu.Unlock()
				log.Printf("Failed to send pong: %v", err)
				return fmt.Errorf("pong write: %w", err)
			}
			writeMu.Unlock()
			continue
		}

		// Handle JSON-RPC tool call request
		if generic.JSONRPC == "2.0" && generic.Method != "" && generic.ID != "" {
			var req JSONRPCRequest
			if err := json.Unmarshal(raw, &req); err != nil {
				log.Printf("Failed to parse JSON-RPC request: %v", err)
				continue
			}

			go c.handleToolCall(ctx, conn, &writeMu, req)
			continue
		}

		// Handle servers_registered ack (from re-registration after reconnect)
		if generic.Type == "servers_registered" {
			log.Printf("Server registration acknowledged")
			continue
		}

		// Handle servers_register_error
		if generic.Type == "servers_register_error" {
			var errMsg struct {
				Message string `json:"message"`
			}
			json.Unmarshal(raw, &errMsg)
			log.Printf("Server registration error: %s", errMsg.Message)
			continue
		}
	}
}

func (c *Client) handleToolCall(ctx context.Context, conn *websocket.Conn, writeMu *sync.Mutex, req JSONRPCRequest) {
	serverName, _ := req.Params["server"].(string)
	toolName, _ := req.Params["tool"].(string)
	args, _ := req.Params["arguments"].(map[string]interface{})

	log.Printf("Tool call: %s/%s (id=%s)", serverName, toolName, req.ID)
	c.emit("tool_call", fmt.Sprintf("%s/%s", serverName, toolName), map[string]interface{}{"server": serverName, "tool": toolName, "id": req.ID})

	result, err := c.caller.CallTool(ctx, serverName, toolName, args)

	var resp JSONRPCResponse
	resp.JSONRPC = "2.0"
	resp.ID = req.ID

	if err != nil {
		log.Printf("Tool call %s/%s failed: %v", serverName, toolName, err)
		resp.Error = &RPCError{Code: -1, Message: err.Error()}
		c.emit("tool_result", fmt.Sprintf("%s/%s failed: %v", serverName, toolName, err), map[string]interface{}{"server": serverName, "tool": toolName, "error": true})
	} else {
		resp.Result = result
		c.emit("tool_result", fmt.Sprintf("%s/%s completed", serverName, toolName), map[string]interface{}{"server": serverName, "tool": toolName, "error": false})
	}

	writeMu.Lock()
	if writeErr := conn.WriteJSON(resp); writeErr != nil {
		log.Printf("Failed to send tool response for %s: %v", req.ID, writeErr)
	}
	writeMu.Unlock()
}

func (c *Client) backoffDelay(attempt int) time.Duration {
	delay := float64(baseReconnectDelay) * math.Pow(reconnectMultiplier, float64(attempt-1))
	if delay > float64(maxReconnectDelay) {
		delay = float64(maxReconnectDelay)
	}
	// Add jitter
	jitter := delay * jitterFraction * (rand.Float64()*2 - 1)
	d := time.Duration(delay + jitter)
	if d < baseReconnectDelay {
		d = baseReconnectDelay
	}
	return d
}
