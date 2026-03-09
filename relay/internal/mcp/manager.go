package mcp

import (
	"context"
	"fmt"
	"log"

	"github.com/PekingSpades/Synapse/relay/internal/config"
)

// ServerInfo describes a server and its tools for registration with the cloud
type ServerInfo struct {
	Name      string     `json:"name"`
	Transport string     `json:"transport"`
	Tools     []ToolInfo `json:"tools"`
}

// ToolInfo describes a single tool
type ToolInfo struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Parameters  interface{} `json:"parameters"`
}

// Server is the interface for both stdio and http MCP servers
type Server interface {
	Start(ctx context.Context) error
	Initialize() error
	ListTools() ([]Tool, error)
	CallTool(ctx context.Context, toolName string, args map[string]interface{}) (interface{}, error)
	Shutdown()
}

type serverEntry struct {
	name      string
	transport string
	server    Server
	tools     []Tool
}

type Manager struct {
	configs []config.ServerConfig
	servers []serverEntry
}

func NewManager(configs []config.ServerConfig) *Manager {
	return &Manager{configs: configs}
}

// InitAll starts all configured MCP servers, initializes them, and discovers their tools
func (m *Manager) InitAll(ctx context.Context) error {
	for _, cfg := range m.configs {
		var srv Server

		switch cfg.Transport {
		case "stdio":
			s := NewStdioServer(cfg.Command, cfg.Args, cfg.Env)
			if err := s.Start(ctx); err != nil {
				return fmt.Errorf("server %s: start: %w", cfg.Name, err)
			}
			srv = s

		case "http":
			s := NewHTTPServer(cfg.Endpoint)
			if err := s.Start(ctx); err != nil {
				return fmt.Errorf("server %s: start: %w", cfg.Name, err)
			}
			srv = s

		default:
			return fmt.Errorf("server %s: unsupported transport %q", cfg.Name, cfg.Transport)
		}

		// Initialize
		if err := srv.Initialize(); err != nil {
			log.Printf("Warning: server %s initialize failed: %v", cfg.Name, err)
			srv.Shutdown()
			continue
		}

		// Discover tools
		tools, err := srv.ListTools()
		if err != nil {
			log.Printf("Warning: server %s tools/list failed: %v", cfg.Name, err)
			srv.Shutdown()
			continue
		}

		m.servers = append(m.servers, serverEntry{
			name:      cfg.Name,
			transport: cfg.Transport,
			server:    srv,
			tools:     tools,
		})
	}

	if len(m.servers) == 0 {
		return fmt.Errorf("no MCP servers initialized successfully")
	}

	return nil
}

// GetServerInfo returns server metadata for registration with the cloud
func (m *Manager) GetServerInfo() []ServerInfo {
	var infos []ServerInfo
	for _, s := range m.servers {
		tools := make([]ToolInfo, len(s.tools))
		for i, t := range s.tools {
			params := t.Parameters
			if params == nil {
				params = t.InputSchema
			}
			tools[i] = ToolInfo{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  params,
			}
		}
		infos = append(infos, ServerInfo{
			Name:      s.name,
			Transport: s.transport,
			Tools:     tools,
		})
	}
	return infos
}

// CallTool routes a tool call to the appropriate server
func (m *Manager) CallTool(ctx context.Context, serverName, toolName string, args map[string]interface{}) (interface{}, error) {
	for _, s := range m.servers {
		if s.name == serverName {
			return s.server.CallTool(ctx, toolName, args)
		}
	}
	return nil, fmt.Errorf("server %q not found", serverName)
}

// ShutdownAll stops all MCP servers
func (m *Manager) ShutdownAll() {
	for _, s := range m.servers {
		log.Printf("Shutting down MCP server: %s", s.name)
		s.server.Shutdown()
	}
}
