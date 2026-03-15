package chrome

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

const callTimeout = 60 * time.Second

type delegateServer struct {
	command string
	args    []string
	env     map[string]string

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	reader *bufio.Reader

	mu    sync.Mutex
	idSeq int32

	lines chan lineResult
}

type lineResult struct {
	data []byte
	err  error
}

func newDelegateServer(command string, args []string, env map[string]string) *delegateServer {
	return &delegateServer{
		command: command,
		args:    args,
		env:     env,
		lines:   make(chan lineResult, 64),
	}
}

func (s *delegateServer) Start(ctx context.Context) error {
	s.cmd = exec.CommandContext(ctx, s.command, s.args...)
	applyPlatformProcessAttrs(s.cmd)

	s.cmd.Env = os.Environ()
	for key, value := range s.env {
		s.cmd.Env = append(s.cmd.Env, fmt.Sprintf("%s=%s", key, value))
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
	s.reader = bufio.NewReaderSize(stdout, 1024*1024)

	if err := s.cmd.Start(); err != nil {
		return fmt.Errorf("start process: %w", err)
	}

	go s.readLinesLoop()
	return nil
}

func (s *delegateServer) Initialize() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := int(atomic.AddInt32(&s.idSeq, 1))
	req := initializeRequest{
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

	var result initializeResult
	if err := s.readMessage(context.Background(), &result, 30*time.Second); err != nil {
		return fmt.Errorf("read initialize response: %w", err)
	}
	if result.Error != nil {
		return fmt.Errorf("initialize error: %s", result.Error.Message)
	}

	return s.writeMessage(notificationMessage{
		JSONRPC: "2.0",
		Method:  "notifications/initialized",
	})
}

func (s *delegateServer) ListTools() ([]core.Tool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := int(atomic.AddInt32(&s.idSeq, 1))
	req := toolsListRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "tools/list",
	}
	if err := s.writeMessage(req); err != nil {
		return nil, fmt.Errorf("send tools/list: %w", err)
	}

	var result toolsListResult
	if err := s.readMessage(context.Background(), &result, 30*time.Second); err != nil {
		return nil, fmt.Errorf("read tools/list response: %w", err)
	}
	if result.Error != nil {
		return nil, fmt.Errorf("tools/list error: %s", result.Error.Message)
	}

	tools := make([]core.Tool, 0, len(result.Result.Tools))
	for _, tool := range result.Result.Tools {
		schema := tool.InputSchema
		if schema == nil {
			schema = tool.Parameters
		}
		tools = append(tools, core.Tool{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: schema,
		})
	}
	return tools, nil
}

func (s *delegateServer) CallTool(ctx context.Context, toolName string, args map[string]interface{}) (core.CallResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := int(atomic.AddInt32(&s.idSeq, 1))
	req := toolCallRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "tools/call",
	}
	req.Params.Name = toolName
	req.Params.Arguments = args

	if err := s.writeMessage(req); err != nil {
		return core.CallResult{}, fmt.Errorf("send tools/call: %w", err)
	}

	var result toolCallResult
	if err := s.readMessage(ctx, &result, callTimeout); err != nil {
		return core.CallResult{}, fmt.Errorf("read tools/call response: %w", err)
	}
	if result.Error != nil {
		return core.CallResult{}, fmt.Errorf("tools/call error: %s", result.Error.Message)
	}

	return core.CallResult{
		Content:           result.Result.Content,
		StructuredContent: result.Result.StructuredContent,
		IsError:           result.Result.IsError,
	}, nil
}

func (s *delegateServer) Shutdown() {
	if s.stdin != nil {
		_ = s.stdin.Close()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		done := make(chan error, 1)
		go func() {
			done <- s.cmd.Wait()
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = s.cmd.Process.Kill()
			<-done
		}
	}
}

func (s *delegateServer) readLinesLoop() {
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

func (s *delegateServer) handleNotification(line []byte) bool {
	var msg struct {
		Method string          `json:"method"`
		ID     json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(line, &msg); err != nil {
		return false
	}
	return msg.Method != "" && len(msg.ID) == 0
}

func (s *delegateServer) writeMessage(message interface{}) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = s.stdin.Write(data)
	return err
}

func (s *delegateServer) readMessage(ctx context.Context, target interface{}, timeout time.Duration) error {
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
			if len(lr.data) <= 1 {
				continue
			}

			var generic map[string]interface{}
			if err := json.Unmarshal(lr.data, &generic); err != nil {
				continue
			}
			if _, hasID := generic["id"]; !hasID {
				continue
			}
			return json.Unmarshal(lr.data, target)
		}
	}
}
