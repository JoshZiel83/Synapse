package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

const stdioCallTimeout = 60 * time.Second // max time for a single JSON-RPC call over stdio

// StdioServer manages a child process that speaks JSON-RPC 2.0 over stdin/stdout
type StdioServer struct {
	command string
	args    []string
	env     map[string]string

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	reader *bufio.Reader

	mu    sync.Mutex // serialize requests to single-threaded server
	idSeq int32
	tools []Tool

	// Channel-based reader for timeout support
	lines chan lineResult
	done  chan struct{}

	onToolsListChanged func()
}

type lineResult struct {
	data []byte
	err  error
}

func NewStdioServer(command string, args []string, env map[string]string) *StdioServer {
	return &StdioServer{
		command: command,
		args:    args,
		env:     env,
		lines:   make(chan lineResult, 64),
		done:    make(chan struct{}),
	}
}

func (s *StdioServer) Start(ctx context.Context) error {
	s.cmd = exec.CommandContext(ctx, s.command, s.args...)
	applyPlatformProcessAttrs(s.cmd)

	// Set environment
	s.cmd.Env = os.Environ()
	for k, v := range s.env {
		s.cmd.Env = append(s.cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}

	var err error
	s.stdin, err = s.cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %w", err)
	}

	stdout, err := s.cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}

	s.cmd.Stderr = os.Stderr
	s.reader = bufio.NewReaderSize(stdout, 1024*1024) // 1MB buffer

	if err := s.cmd.Start(); err != nil {
		return fmt.Errorf("start process: %w", err)
	}

	// Start background line reader goroutine
	go s.readLinesLoop()

	return nil
}

// readLinesLoop continuously reads lines from stdout and sends them to the lines channel.
// This runs in a background goroutine so readMessage can use select with timeout.
func (s *StdioServer) readLinesLoop() {
	defer close(s.lines)
	for {
		line, err := s.reader.ReadBytes('\n')
		if err != nil {
			if err != io.EOF {
				s.lines <- lineResult{err: err}
			}
			return
		}
		if s.handleNotification(line) {
			continue
		}
		s.lines <- lineResult{data: line}
	}
}

func (s *StdioServer) Initialize() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := int(atomic.AddInt32(&s.idSeq, 1))
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

	if err := s.writeMessage(req); err != nil {
		return fmt.Errorf("send initialize: %w", err)
	}

	var result InitializeResult
	if err := s.readMessage(context.Background(), &result, 30*time.Second); err != nil {
		return fmt.Errorf("read initialize response: %w", err)
	}

	if result.Error != nil {
		return fmt.Errorf("initialize error: %s", result.Error.Message)
	}

	// Send initialized notification
	notif := NotificationMessage{
		JSONRPC: "2.0",
		Method:  "notifications/initialized",
	}
	if err := s.writeMessage(notif); err != nil {
		return fmt.Errorf("send initialized: %w", err)
	}

	return nil
}

func (s *StdioServer) ListTools() ([]Tool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := int(atomic.AddInt32(&s.idSeq, 1))
	req := ToolsListRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "tools/list",
	}

	if err := s.writeMessage(req); err != nil {
		return nil, fmt.Errorf("send tools/list: %w", err)
	}

	var result ToolsListResult
	if err := s.readMessage(context.Background(), &result, 30*time.Second); err != nil {
		return nil, fmt.Errorf("read tools/list response: %w", err)
	}

	if result.Error != nil {
		return nil, fmt.Errorf("tools/list error: %s", result.Error.Message)
	}

	// Normalize: prefer inputSchema over parameters
	for i, t := range result.Result.Tools {
		if t.InputSchema != nil && t.Parameters == nil {
			result.Result.Tools[i].Parameters = t.InputSchema
		}
	}

	s.tools = result.Result.Tools
	return result.Result.Tools, nil
}

func (s *StdioServer) CallTool(ctx context.Context, toolName string, args map[string]interface{}) (interface{}, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := int(atomic.AddInt32(&s.idSeq, 1))
	req := ToolCallRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "tools/call",
	}
	req.Params.Name = toolName
	req.Params.Arguments = args

	if err := s.writeMessage(req); err != nil {
		return nil, fmt.Errorf("send tools/call: %w", err)
	}

	var result ToolCallResult
	if err := s.readMessage(ctx, &result, stdioCallTimeout); err != nil {
		return nil, fmt.Errorf("read tools/call response: %w", err)
	}

	if result.Error != nil {
		return nil, fmt.Errorf("tools/call error: %s", result.Error.Message)
	}

	return map[string]interface{}{
		"content": result.Result.Content,
		"isError": result.Result.IsError,
	}, nil
}

func (s *StdioServer) Shutdown() {
	// Signal reader goroutine to stop (closing stdin causes child process to exit)
	if s.stdin != nil {
		s.stdin.Close()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		// Give the process a moment to exit gracefully, then force kill
		done := make(chan error, 1)
		go func() { done <- s.cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			s.cmd.Process.Kill()
			<-done
		}
	}
}

func (s *StdioServer) SetToolsChangedHandler(handler func()) {
	s.onToolsListChanged = handler
}

func (s *StdioServer) writeMessage(msg interface{}) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = s.stdin.Write(data)
	return err
}

// readMessage reads the next JSON-RPC response from the child process stdout,
// skipping notifications (messages without an "id" field).
// Returns error if no response arrives within the given timeout.
func (s *StdioServer) readMessage(ctx context.Context, target interface{}, timeout time.Duration) error {
	if ctx == nil {
		ctx = context.Background()
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return fmt.Errorf("timeout waiting for response after %v", timeout)
		case lr, ok := <-s.lines:
			if !ok {
				return fmt.Errorf("child process exited (stdout closed)")
			}
			if lr.err != nil {
				return fmt.Errorf("read line: %w", lr.err)
			}

			line := lr.data
			// Skip empty lines
			if len(line) <= 1 {
				continue
			}

			// Try to parse — skip notifications (no id field)
			var generic map[string]interface{}
			if err := json.Unmarshal(line, &generic); err != nil {
				log.Printf("[stdio] Skip unparseable line: %s", string(line[:min(len(line), 200)]))
				continue
			}

			// Skip notifications (messages without id field — these are server notifications)
			if _, hasID := generic["id"]; !hasID {
				continue
			}

			return json.Unmarshal(line, target)
		}
	}
}

func (s *StdioServer) handleNotification(line []byte) bool {
	var msg struct {
		Method string          `json:"method"`
		ID     json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(line, &msg); err != nil {
		return false
	}

	if msg.Method == "" || len(msg.ID) > 0 {
		return false
	}

	if msg.Method == "notifications/tools/list_changed" && s.onToolsListChanged != nil {
		s.onToolsListChanged()
	}
	return true
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
