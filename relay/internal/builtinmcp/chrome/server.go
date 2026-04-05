package chrome

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/chromemcpbundle"
	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
)

type Server struct {
	cfg      Config
	tools    []core.Tool
	delegate *delegateServer
	startCtx context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	ready    bool
}

func New(cfg Config) (*Server, error) {
	if cfg.ConnectionMode == "" {
		cfg.ConnectionMode = "managed"
	}
	if cfg.Channel == "" {
		cfg.Channel = "stable"
	}
	tools, err := staticCatalog(cfg.Slim)
	if err != nil {
		return nil, err
	}
	return &Server{cfg: cfg, tools: tools}, nil
}

func (s *Server) Start(ctx context.Context) error {
	childCtx, cancel := context.WithCancel(ctx)

	s.mu.Lock()
	s.startCtx = childCtx
	s.cancel = cancel
	shouldActivate := s.isAuthorized(false)
	s.mu.Unlock()

	if !shouldActivate {
		return nil
	}

	return s.ensureReady(childCtx)
}

func (s *Server) Initialize() error {
	if !s.isAuthorized(false) {
		return nil
	}
	return s.ensureReady(nil)
}

func (s *Server) ListTools() ([]core.Tool, error) {
	tools := make([]core.Tool, len(s.tools))
	copy(tools, s.tools)
	return tools, nil
}

func (s *Server) CallTool(ctx context.Context, toolName string, args map[string]interface{}) (core.CallResult, error) {
	if !s.isAuthorized(runtimeauth.HasServerAuthorization(ctx)) {
		return disabledResult(toolName), nil
	}
	if err := s.ensureReady(ctx); err != nil {
		return core.CallResult{}, err
	}

	s.mu.Lock()
	delegate := s.delegate
	s.mu.Unlock()
	if delegate == nil {
		return core.CallResult{}, fmt.Errorf("chrome devtools delegate is not started")
	}
	return delegate.CallTool(ctx, toolName, args)
}

func (s *Server) Shutdown() {
	s.mu.Lock()
	cancel := s.cancel
	delegate := s.delegate
	s.cancel = nil
	s.delegate = nil
	s.ready = false
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if delegate != nil {
		delegate.Shutdown()
	}
}

func (s *Server) isAuthorized(serverAuthorized bool) bool {
	return s.cfg.Enabled || serverAuthorized
}

func (s *Server) ensureReady(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.delegate == nil {
		if err := s.startDelegateLocked(ctx); err != nil {
			return err
		}
	}
	if s.ready {
		return nil
	}
	if err := s.delegate.Initialize(); err != nil {
		return err
	}
	s.ready = true
	return nil
}

func (s *Server) startDelegateLocked(ctx context.Context) error {
	installation, err := chromemcpbundle.EnsureInstalled()
	if err != nil {
		return err
	}

	logFile := s.cfg.LogFile
	if logFile == "" {
		baseDir := strings.TrimSpace(s.cfg.LogsDir)
		if baseDir == "" {
			baseDir = "."
		}
		logFile = filepath.Join(baseDir, s.cfg.InstanceID+".log")
	}
	if err := os.MkdirAll(filepath.Dir(logFile), 0o755); err != nil {
		return fmt.Errorf("create chrome-devtools log directory: %w", err)
	}

	args, err := s.commandArgs(installation, logFile)
	if err != nil {
		return err
	}

	delegate := newDelegateServer(installation.NodeBinaryPath, args, nil)
	startCtx := ctx
	if startCtx == nil {
		startCtx = s.startCtx
	}
	if startCtx == nil {
		startCtx = context.Background()
	}
	if err := delegate.Start(startCtx); err != nil {
		return err
	}
	s.delegate = delegate
	return nil
}

func disabledResult(toolName string) core.CallResult {
	message := "This built-in browser MCP server is currently blocked by the relay client's local policy. Synapse can continue after the matching relay authorization is approved."
	return core.CallResult{
		Content: []interface{}{core.Text(message)},
		StructuredContent: core.WithRelayAccessDenial(map[string]interface{}{
			"code":       "server_disabled",
			"tool":       toolName,
			"capability": "chrome",
			"message":    message,
		}, core.RelayAccessDenialKindPermissionDenied, core.RelayAccessDenialResolutionServerGrant),
		IsError: true,
	}
}

func (s *Server) commandArgs(installation *chromemcpbundle.Installation, logFile string) ([]string, error) {
	args := []string{installation.EntryScript}

	if !s.cfg.UsageStatistics {
		args = append(args, "--no-usage-statistics")
	}
	if !s.cfg.PerformanceCrux {
		args = append(args, "--no-performance-crux")
	}
	if s.cfg.Slim {
		args = append(args, "--slim")
	}
	if s.cfg.AcceptInsecureCerts {
		args = append(args, "--accept-insecure-certs")
	}
	if logFile != "" {
		args = append(args, "--log-file", logFile)
	}

	for _, value := range s.cfg.ChromeArgs {
		args = append(args, "--chrome-arg", value)
	}
	for _, value := range s.cfg.IgnoreDefaultChromeArgs {
		args = append(args, "--ignore-default-chrome-arg", value)
	}

	switch s.cfg.ConnectionMode {
	case "managed":
		if s.cfg.Headless {
			args = append(args, "--headless")
		}
		if s.cfg.ExecutablePath != "" {
			args = append(args, "--executable-path", s.cfg.ExecutablePath)
		}
		if s.cfg.Isolated {
			args = append(args, "--isolated")
		} else if s.cfg.UserDataDir != "" {
			if err := os.MkdirAll(s.cfg.UserDataDir, 0755); err != nil {
				return nil, fmt.Errorf("create managed chrome profile dir: %w", err)
			}
			args = append(args, "--user-data-dir", s.cfg.UserDataDir)
		}
		if s.cfg.Channel != "" {
			args = append(args, "--channel", s.cfg.Channel)
		}
	case "attach_existing":
		args = append(args, "--auto-connect")
		if s.cfg.UserDataDir != "" {
			args = append(args, "--user-data-dir", s.cfg.UserDataDir)
		} else if s.cfg.Channel != "" {
			args = append(args, "--channel", s.cfg.Channel)
		}
	case "attach_url":
		if s.cfg.BrowserURL != "" {
			args = append(args, "--browser-url", s.cfg.BrowserURL)
		}
		if s.cfg.WSEndpoint != "" {
			args = append(args, "--ws-endpoint", s.cfg.WSEndpoint)
		}
		if len(s.cfg.WSHeaders) > 0 {
			encodedHeaders, err := json.Marshal(s.cfg.WSHeaders)
			if err != nil {
				return nil, fmt.Errorf("encode chrome ws headers: %w", err)
			}
			args = append(args, "--ws-headers", string(encodedHeaders))
		}
	default:
		return nil, fmt.Errorf("unsupported chrome connection mode %q", s.cfg.ConnectionMode)
	}

	return args, nil
}
