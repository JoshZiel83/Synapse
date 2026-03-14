package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"

	"github.com/PekingSpades/Synapse/relay/internal/config"
)

// ServerInfo describes a server and its tools for registration with the cloud
type ServerInfo struct {
	StableKey      string                 `json:"stableKey"`
	SyncSourceKey  string                 `json:"syncSourceKey,omitempty"`
	ManagementMode string                 `json:"managementMode"`
	Name           string                 `json:"name"`
	Transport      string                 `json:"transport"`
	Metadata       map[string]interface{} `json:"metadata,omitempty"`
	Tools          []ToolInfo             `json:"tools"`
}

// ToolInfo describes a single tool
type ToolInfo struct {
	StableKey   string      `json:"stableKey"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema interface{} `json:"inputSchema"`
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
	stableKey      string
	syncSourceKey  string
	managementMode string
	name           string
	transport      string
	metadata       map[string]interface{}
	server         Server
	tools          []Tool
}

type toolListChangeNotifier interface {
	SetToolsChangedHandler(handler func())
}

type Manager struct {
	configs []config.ServerConfig
	servers []serverEntry
	mu      sync.RWMutex
	hints   chan struct{}

	// OnEvent is an optional callback for relay events (e.g. for GUI observability).
	OnEvent func(evtType string, msg string, data map[string]interface{})
}

func NewManager(configs []config.ServerConfig) *Manager {
	return &Manager{
		configs: configs,
		hints:   make(chan struct{}, 1),
	}
}

func (m *Manager) emit(evtType, msg string, data map[string]interface{}) {
	if m.OnEvent != nil {
		m.OnEvent(evtType, msg, data)
	}
}

// InitAll starts all configured MCP servers, initializes them, and discovers their tools
func (m *Manager) InitAll(ctx context.Context) error {
	for _, cfg := range m.configs {
		var srv Server

		m.emit("server_init", fmt.Sprintf("Initializing server %s (%s)", cfg.Name, cfg.Transport), map[string]interface{}{"server": cfg.Name, "transport": cfg.Transport})

		switch cfg.Transport {
		case "stdio":
			srv = NewStdioServer(cfg.Command, cfg.Args, cfg.Env)

		case "http":
			srv = NewHTTPServer(cfg.Endpoint)

		default:
			return fmt.Errorf("server %s: unsupported transport %q", cfg.Name, cfg.Transport)
		}

		serverName := cfg.Name
		stableKey := cfg.StableKey
		if notifier, ok := srv.(toolListChangeNotifier); ok {
			notifier.SetToolsChangedHandler(func() {
				m.notifyCatalogHint(serverName, stableKey)
			})
		}
		if err := srv.Start(ctx); err != nil {
			return fmt.Errorf("server %s: start: %w", cfg.Name, err)
		}

		// Initialize
		if err := srv.Initialize(); err != nil {
			log.Printf("Warning: server %s initialize failed: %v", cfg.Name, err)
			m.emit("server_failed", fmt.Sprintf("Server %s initialize failed: %v", cfg.Name, err), map[string]interface{}{"server": cfg.Name})
			srv.Shutdown()
			continue
		}

		// Discover tools
		tools, err := srv.ListTools()
		if err != nil {
			log.Printf("Warning: server %s tools/list failed: %v", cfg.Name, err)
			m.emit("server_failed", fmt.Sprintf("Server %s tools/list failed: %v", cfg.Name, err), map[string]interface{}{"server": cfg.Name})
			srv.Shutdown()
			continue
		}

		m.mu.Lock()
		m.servers = append(m.servers, serverEntry{
			stableKey:      cfg.StableKey,
			syncSourceKey:  cfg.SyncSourceKey,
			managementMode: cfg.ManagementMode,
			name:           cfg.Name,
			transport:      cfg.Transport,
			metadata:       configCloneMetadata(cfg.Metadata),
			server:         srv,
			tools:          tools,
		})
		m.mu.Unlock()
	}

	m.mu.RLock()
	serverCount := len(m.servers)
	m.mu.RUnlock()
	if serverCount == 0 {
		return fmt.Errorf("no MCP servers initialized successfully")
	}

	return nil
}

// GetServerInfo returns server metadata for registration with the cloud
func (m *Manager) GetServerInfo() []ServerInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var infos []ServerInfo
	for _, s := range m.servers {
		tools := make([]ToolInfo, len(s.tools))
		for i, t := range s.tools {
			params := t.Parameters
			if params == nil {
				params = t.InputSchema
			}
			tools[i] = ToolInfo{
				StableKey:   stableKeyForTool(t.Name),
				Name:        t.Name,
				Description: t.Description,
				InputSchema: params,
			}
		}
		infos = append(infos, ServerInfo{
			StableKey:      s.stableKey,
			SyncSourceKey:  s.syncSourceKey,
			ManagementMode: s.managementMode,
			Name:           s.name,
			Transport:      s.transport,
			Metadata:       configCloneMetadata(s.metadata),
			Tools:          tools,
		})
	}
	return infos
}

// CallTool routes a tool call to the appropriate server
func (m *Manager) CallTool(ctx context.Context, exposureStableKey, toolName string, args map[string]interface{}) (interface{}, error) {
	m.mu.RLock()
	var target Server
	for _, s := range m.servers {
		if s.stableKey == exposureStableKey {
			target = s.server
			break
		}
	}
	m.mu.RUnlock()

	if target != nil {
		return target.CallTool(ctx, toolName, args)
	}
	return nil, fmt.Errorf("relay exposure %q not found", exposureStableKey)
}

// ShutdownAll stops all MCP servers
func (m *Manager) ShutdownAll() {
	m.mu.RLock()
	servers := make([]serverEntry, len(m.servers))
	copy(servers, m.servers)
	m.mu.RUnlock()

	for _, s := range servers {
		log.Printf("Shutting down MCP server: %s", s.name)
		s.server.Shutdown()
	}
}

func (m *Manager) CatalogHints() <-chan struct{} {
	return m.hints
}

func (m *Manager) RefreshToolCatalogs() (bool, []ServerInfo, error) {
	m.mu.RLock()
	servers := make([]serverEntry, len(m.servers))
	copy(servers, m.servers)
	m.mu.RUnlock()

	changed := false
	for index, current := range servers {
		tools, err := current.server.ListTools()
		if err != nil {
			m.emit("server_failed", fmt.Sprintf("Server %s tools/list refresh failed: %v", current.name, err), map[string]interface{}{
				"server":    current.name,
				"stableKey": current.stableKey,
			})
			continue
		}

		if toolCatalogEqual(current.tools, tools) {
			continue
		}

		changed = true
		m.mu.Lock()
		if index < len(m.servers) && m.servers[index].stableKey == current.stableKey {
			m.servers[index].tools = tools
		} else {
			for serverIndex := range m.servers {
				if m.servers[serverIndex].stableKey == current.stableKey {
					m.servers[serverIndex].tools = tools
					break
				}
			}
		}
		m.mu.Unlock()

		m.emit("catalog_changed", fmt.Sprintf("Tool catalog changed for %s", current.name), map[string]interface{}{
			"server":    current.name,
			"stableKey": current.stableKey,
			"toolCount": len(tools),
		})
	}

	if !changed {
		return false, nil, nil
	}

	return true, m.GetServerInfo(), nil
}

func stableKeyForTool(name string) string {
	return "tool_" + name
}

func configCloneMetadata(input map[string]interface{}) map[string]interface{} {
	if len(input) == 0 {
		return map[string]interface{}{}
	}

	output := make(map[string]interface{}, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func (m *Manager) notifyCatalogHint(serverName, stableKey string) {
	m.emit("catalog_hint", fmt.Sprintf("Tool catalog change notified by %s", serverName), map[string]interface{}{
		"server":    serverName,
		"stableKey": stableKey,
	})

	select {
	case m.hints <- struct{}{}:
	default:
	}
}

func toolCatalogEqual(left, right []Tool) bool {
	if len(left) != len(right) {
		return false
	}

	leftPayload, err := json.Marshal(normalizeToolCatalog(left))
	if err != nil {
		return false
	}
	rightPayload, err := json.Marshal(normalizeToolCatalog(right))
	if err != nil {
		return false
	}
	return string(leftPayload) == string(rightPayload)
}

func normalizeToolCatalog(tools []Tool) []map[string]interface{} {
	normalized := make([]map[string]interface{}, len(tools))
	for i, tool := range tools {
		parameters := tool.Parameters
		if parameters == nil {
			parameters = tool.InputSchema
		}
		normalized[i] = map[string]interface{}{
			"name":        tool.Name,
			"description": tool.Description,
			"parameters":  parameters,
		}
	}
	return normalized
}
