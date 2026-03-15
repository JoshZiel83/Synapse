package chrome

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/chromemcpbundle"
	"github.com/PekingSpades/Synapse/relay/internal/config"
)

type Server struct {
	cfg      Config
	delegate *delegateServer
}

func New(cfg Config) (*Server, error) {
	if cfg.ConnectionMode == "" {
		cfg.ConnectionMode = "managed"
	}
	if cfg.Channel == "" {
		cfg.Channel = "stable"
	}
	return &Server{cfg: cfg}, nil
}

func (s *Server) Start(ctx context.Context) error {
	installation, err := chromemcpbundle.EnsureInstalled()
	if err != nil {
		return err
	}

	logFile := s.cfg.LogFile
	if logFile == "" {
		logFile = filepath.Join(config.DefaultDir(), "logs", "chrome-devtools-mcp", s.cfg.InstanceID+".log")
	}
	if err := os.MkdirAll(filepath.Dir(logFile), 0755); err != nil {
		return fmt.Errorf("create chrome-devtools log directory: %w", err)
	}

	args, err := s.commandArgs(installation, logFile)
	if err != nil {
		return err
	}

	s.delegate = newDelegateServer(installation.NodeBinaryPath, args, nil)
	return s.delegate.Start(ctx)
}

func (s *Server) Initialize() error {
	if s.delegate == nil {
		return fmt.Errorf("chrome devtools delegate is not started")
	}
	return s.delegate.Initialize()
}

func (s *Server) ListTools() ([]core.Tool, error) {
	if s.delegate == nil {
		return nil, fmt.Errorf("chrome devtools delegate is not started")
	}
	return s.delegate.ListTools()
}

func (s *Server) CallTool(ctx context.Context, toolName string, args map[string]interface{}) (core.CallResult, error) {
	if s.delegate == nil {
		return core.CallResult{}, fmt.Errorf("chrome devtools delegate is not started")
	}
	return s.delegate.CallTool(ctx, toolName, args)
}

func (s *Server) Shutdown() {
	if s.delegate != nil {
		s.delegate.Shutdown()
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
