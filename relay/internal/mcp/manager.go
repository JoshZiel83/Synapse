package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/cloud"
	"github.com/PekingSpades/Synapse/relay/internal/config"
)

// ServerInfo describes a server and its tools for registration with the cloud
type ServerInfo struct {
	StableKey     string                 `json:"stableKey"`
	SyncSourceKey string                 `json:"syncSourceKey,omitempty"`
	Name          string                 `json:"name"`
	Transport     string                 `json:"transport"`
	Metadata      map[string]interface{} `json:"metadata,omitempty"`
	Tools         []ToolInfo             `json:"tools"`
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
	cfg           config.ServerConfig
	stableKey     string
	syncSourceKey string
	name          string
	transport     string
	metadata      map[string]interface{}
	server        Server
	tools         []Tool
}

type pendingServerEntry struct {
	cfg         config.ServerConfig
	lastPhase   string
	lastErr     error
	retryCount  int
	nextRetryAt time.Time
}

type serverFactory func(config.ServerConfig) (Server, error)

type serverAttemptError struct {
	phase     string
	err       error
	retryable bool
}

func (e *serverAttemptError) Error() string {
	if e == nil || e.err == nil {
		return ""
	}
	return e.err.Error()
}

type toolListChangeNotifier interface {
	SetToolsChangedHandler(handler func())
}

type metadataProvider interface {
	Metadata() map[string]interface{}
}

type Manager struct {
	configs   []config.ServerConfig
	servers   []serverEntry
	pending   map[string]*pendingServerEntry
	newServer serverFactory
	mu        sync.RWMutex
	hints     chan struct{}

	// OnEvent is an optional callback for relay events (e.g. for GUI observability).
	OnEvent func(evtType string, msg string, data map[string]interface{})
}

func NewManager(configs []config.ServerConfig) *Manager {
	return &Manager{
		configs:   configs,
		pending:   make(map[string]*pendingServerEntry),
		newServer: defaultServerFactory,
		hints:     make(chan struct{}, 1),
	}
}

func (m *Manager) emit(evtType, msg string, data map[string]interface{}) {
	if m.OnEvent != nil {
		m.OnEvent(evtType, msg, data)
	}
}

func shouldInitializeServer(cfg config.ServerConfig) bool {
	if config.ServerEnabled(cfg) {
		return true
	}
	if cfg.Transport != "builtin" || cfg.Builtin == nil {
		return false
	}

	switch strings.TrimSpace(strings.ToLower(cfg.Builtin.Kind)) {
	case "chrome", "cua", "filesystem":
		return true
	default:
		return false
	}
}

func defaultServerFactory(cfg config.ServerConfig) (Server, error) {
	switch cfg.Transport {
	case "stdio":
		return NewStdioServer(cfg.Command, cfg.Args, cfg.Env), nil
	case "http":
		return NewHTTPServer(cfg.Endpoint), nil
	case "builtin":
		return newBuiltinServer(cfg)
	default:
		return nil, fmt.Errorf("unsupported transport %q", cfg.Transport)
	}
}

func isRetryableServerError(err error) bool {
	type temporary interface {
		Temporary() bool
	}

	var temp temporary
	return errors.As(err, &temp) && temp.Temporary()
}

func pendingRetryDelay(attempt int) time.Duration {
	if attempt <= 1 {
		return 5 * time.Second
	}

	delay := 5 * time.Second
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= time.Minute {
			return time.Minute
		}
	}
	return delay
}

func pendingMessage(phase string) string {
	switch phase {
	case "builtin init":
		return "builtin init"
	case "start":
		return "start"
	case "initialize":
		return "initialize"
	case "tools/list":
		return "tools/list"
	case "restart":
		return "restart"
	default:
		return "prepare"
	}
}

// InitAll starts all configured MCP servers, initializes them, and discovers their tools
func (m *Manager) InitAll(ctx context.Context) error {
	for _, cfg := range m.configs {
		if !shouldInitializeServer(cfg) {
			m.emit("server_skipped", fmt.Sprintf("Skipping disabled server %s", cfg.Name), map[string]interface{}{
				"server":    cfg.Name,
				"stableKey": cfg.StableKey,
			})
			continue
		}

		entry, err := m.attemptServerStart(ctx, cfg)
		if err != nil {
			m.handleAttemptError(cfg, err)
			continue
		}

		m.mu.Lock()
		m.servers = append(m.servers, *entry)
		m.mu.Unlock()
	}

	m.mu.RLock()
	serverCount := len(m.servers)
	pendingCount := len(m.pending)
	m.mu.RUnlock()
	if serverCount == 0 && pendingCount == 0 {
		return fmt.Errorf("no MCP servers initialized successfully")
	}

	return nil
}

func (m *Manager) PendingServerCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.pending)
}

func (m *Manager) attemptServerStart(ctx context.Context, cfg config.ServerConfig) (*serverEntry, *serverAttemptError) {
	m.emit("server_init", fmt.Sprintf("Initializing server %s (%s)", cfg.Name, cfg.Transport), map[string]interface{}{
		"server":    cfg.Name,
		"stableKey": cfg.StableKey,
		"transport": cfg.Transport,
	})

	srv, err := m.newServer(cfg)
	if err != nil {
		return nil, &serverAttemptError{
			phase:     "builtin init",
			err:       err,
			retryable: isRetryableServerError(err),
		}
	}

	serverName := cfg.Name
	stableKey := cfg.StableKey
	if notifier, ok := srv.(toolListChangeNotifier); ok {
		notifier.SetToolsChangedHandler(func() {
			m.notifyCatalogHint(serverName, stableKey)
		})
	}

	if err := srv.Start(ctx); err != nil {
		return nil, &serverAttemptError{
			phase:     "start",
			err:       err,
			retryable: isRetryableServerError(err),
		}
	}

	if err := srv.Initialize(); err != nil {
		srv.Shutdown()
		return nil, &serverAttemptError{
			phase:     "initialize",
			err:       err,
			retryable: isRetryableServerError(err),
		}
	}

	tools, err := srv.ListTools()
	if err != nil {
		srv.Shutdown()
		return nil, &serverAttemptError{
			phase:     "tools/list",
			err:       err,
			retryable: isRetryableServerError(err),
		}
	}

	metadata := configCloneMetadata(cfg.Metadata)
	if metadata == nil {
		metadata = map[string]interface{}{}
	}
	if cfg.Transport == "builtin" && cfg.Builtin != nil {
		metadata["builtinKind"] = cfg.Builtin.Kind
		metadata["trustRemoteAuthorization"] = true
	}
	if provider, ok := srv.(metadataProvider); ok {
		for key, value := range provider.Metadata() {
			metadata[key] = value
		}
	}

	return &serverEntry{
		cfg:           cfg,
		stableKey:     cfg.StableKey,
		syncSourceKey: cfg.SyncSourceKey,
		name:          cfg.Name,
		transport:     cfg.Transport,
		metadata:      metadata,
		server:        srv,
		tools:         tools,
	}, nil
}

func (m *Manager) handleAttemptError(cfg config.ServerConfig, attemptErr *serverAttemptError) {
	if attemptErr == nil {
		return
	}

	phase := pendingMessage(attemptErr.phase)
	if attemptErr.retryable {
		retryIn, retryCount := m.queuePendingServer(cfg, attemptErr.phase, attemptErr.err)
		log.Printf("Info: server %s %s pending: %v", cfg.Name, phase, attemptErr.err)
		m.emit("server_pending", fmt.Sprintf("Server %s %s pending: %v", cfg.Name, phase, attemptErr.err), map[string]interface{}{
			"server":     cfg.Name,
			"stableKey":  cfg.StableKey,
			"phase":      attemptErr.phase,
			"retryCount": retryCount,
			"retryIn":    retryIn.String(),
		})
		return
	}

	log.Printf("Warning: server %s %s failed: %v", cfg.Name, phase, attemptErr.err)
	m.emit("server_failed", fmt.Sprintf("Server %s %s failed: %v", cfg.Name, phase, attemptErr.err), map[string]interface{}{
		"server":    cfg.Name,
		"stableKey": cfg.StableKey,
		"phase":     attemptErr.phase,
	})
}

func (m *Manager) queuePendingServer(cfg config.ServerConfig, phase string, err error) (time.Duration, int) {
	m.mu.Lock()
	defer m.mu.Unlock()

	entry, ok := m.pending[cfg.StableKey]
	if !ok {
		entry = &pendingServerEntry{cfg: cfg}
		m.pending[cfg.StableKey] = entry
	}

	entry.cfg = cfg
	entry.lastPhase = phase
	entry.lastErr = err
	entry.retryCount++
	retryIn := pendingRetryDelay(entry.retryCount)
	entry.nextRetryAt = time.Now().Add(retryIn)

	return retryIn, entry.retryCount
}

func (m *Manager) removePendingServer(stableKey string) {
	m.mu.Lock()
	delete(m.pending, stableKey)
	m.mu.Unlock()
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
			StableKey:     s.stableKey,
			SyncSourceKey: s.syncSourceKey,
			Name:          s.name,
			Transport:     s.transport,
			Metadata:      configCloneMetadata(s.metadata),
			Tools:         tools,
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

func (m *Manager) StartTask(
	ctx context.Context,
	exposureStableKey, toolName string,
	args map[string]interface{},
	requestedTaskID string,
) (core.TaskSnapshot, error) {
	m.mu.RLock()
	var target interface {
		StartTask(context.Context, string, map[string]interface{}, string) (core.TaskSnapshot, error)
	}
	for _, s := range m.servers {
		if s.stableKey == exposureStableKey {
			candidate, ok := s.server.(interface {
				StartTask(context.Context, string, map[string]interface{}, string) (core.TaskSnapshot, error)
			})
			if ok {
				target = candidate
			}
			break
		}
	}
	m.mu.RUnlock()

	if target == nil {
		return core.TaskSnapshot{}, core.ErrTaskNotSupported
	}
	return target.StartTask(ctx, toolName, args, requestedTaskID)
}

func (m *Manager) GetTask(exposureStableKey, taskID string) (core.TaskSnapshot, error) {
	m.mu.RLock()
	var target interface {
		GetTask(string) (core.TaskSnapshot, error)
	}
	for _, s := range m.servers {
		if s.stableKey == exposureStableKey {
			candidate, ok := s.server.(interface {
				GetTask(string) (core.TaskSnapshot, error)
			})
			if ok {
				target = candidate
			}
			break
		}
	}
	m.mu.RUnlock()

	if target == nil {
		return core.TaskSnapshot{}, core.ErrTaskNotSupported
	}
	return target.GetTask(taskID)
}

func (m *Manager) ReadTaskOutput(
	exposureStableKey, taskID string,
	afterSeq int64,
	limit int,
	stream string,
) ([]core.TaskOutputChunk, error) {
	m.mu.RLock()
	var target interface {
		ReadTaskOutput(string, int64, int, string) ([]core.TaskOutputChunk, error)
	}
	for _, s := range m.servers {
		if s.stableKey == exposureStableKey {
			candidate, ok := s.server.(interface {
				ReadTaskOutput(string, int64, int, string) ([]core.TaskOutputChunk, error)
			})
			if ok {
				target = candidate
			}
			break
		}
	}
	m.mu.RUnlock()

	if target == nil {
		return nil, core.ErrTaskNotSupported
	}
	return target.ReadTaskOutput(taskID, afterSeq, limit, stream)
}

func (m *Manager) CancelTask(exposureStableKey, taskID, reason string) error {
	m.mu.RLock()
	var target interface {
		CancelTask(string, string) error
	}
	for _, s := range m.servers {
		if s.stableKey == exposureStableKey {
			candidate, ok := s.server.(interface {
				CancelTask(string, string) error
			})
			if ok {
				target = candidate
			}
			break
		}
	}
	m.mu.RUnlock()

	if target == nil {
		return core.ErrTaskNotSupported
	}
	return target.CancelTask(taskID, reason)
}

func (m *Manager) OpenRuntimeSession(_ context.Context, request cloud.RuntimeSessionRequest) error {
	if strings.TrimSpace(request.ExposureStableKey) == "" {
		return fmt.Errorf("exposure stable key is required")
	}

	m.mu.RLock()
	exists := false
	for _, s := range m.servers {
		if s.stableKey == request.ExposureStableKey {
			exists = true
			break
		}
	}
	m.mu.RUnlock()

	if !exists {
		return fmt.Errorf("relay exposure %q not found", request.ExposureStableKey)
	}
	return nil
}

func (m *Manager) CloseRuntimeSession(_ context.Context, runtimeSessionID string) error {
	m.mu.RLock()
	servers := make([]serverEntry, len(m.servers))
	copy(servers, m.servers)
	m.mu.RUnlock()

	for _, server := range servers {
		if aware, ok := server.server.(interface{ CloseRuntimeSession(string) }); ok {
			aware.CloseRuntimeSession(runtimeSessionID)
		}
	}
	return nil
}

func (m *Manager) ResetRuntimeSessions(_ context.Context) error {
	m.mu.RLock()
	servers := make([]serverEntry, len(m.servers))
	copy(servers, m.servers)
	m.mu.RUnlock()

	for _, server := range servers {
		if aware, ok := server.server.(interface{ ResetRuntimeSessions() }); ok {
			aware.ResetRuntimeSessions()
		}
	}
	return nil
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

func (m *Manager) RefreshToolCatalogs(ctx context.Context) (bool, []ServerInfo, error) {
	changed := m.retryPendingServers(ctx)

	m.mu.RLock()
	servers := make([]serverEntry, len(m.servers))
	copy(servers, m.servers)
	m.mu.RUnlock()

	for index, current := range servers {
		tools, err := current.server.ListTools()
		if err != nil {
			if isPermanentToolCatalogRefreshError(err) {
				current.server.Shutdown()
				if m.removeServerByStableKey(current.stableKey) {
					changed = true
					m.handleAttemptError(current.cfg, &serverAttemptError{
						phase:     "restart",
						err:       err,
						retryable: true,
					})
				}
				continue
			}
			m.emit("server_failed", fmt.Sprintf("Server %s tools/list refresh failed: %v", current.name, err), map[string]interface{}{
				"server":    current.name,
				"stableKey": current.stableKey,
				"phase":     "tools/list",
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

func (m *Manager) retryPendingServers(ctx context.Context) bool {
	now := time.Now()

	m.mu.RLock()
	pending := make([]pendingServerEntry, 0, len(m.pending))
	for _, entry := range m.pending {
		if !entry.nextRetryAt.IsZero() && now.Before(entry.nextRetryAt) {
			continue
		}
		pending = append(pending, *entry)
	}
	m.mu.RUnlock()

	changed := false
	for _, current := range pending {
		entry, err := m.attemptServerStart(ctx, current.cfg)
		if err != nil {
			m.handleAttemptError(current.cfg, err)
			if !err.retryable {
				m.removePendingServer(current.cfg.StableKey)
			}
			continue
		}

		m.mu.Lock()
		delete(m.pending, current.cfg.StableKey)
		m.servers = append(m.servers, *entry)
		m.mu.Unlock()

		changed = true
		m.emit("server_ready", fmt.Sprintf("Server %s is ready", current.cfg.Name), map[string]interface{}{
			"server":    current.cfg.Name,
			"stableKey": current.cfg.StableKey,
		})
	}

	return changed
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

func (m *Manager) removeServerByStableKey(stableKey string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	for index := range m.servers {
		if m.servers[index].stableKey != stableKey {
			continue
		}
		m.servers = append(m.servers[:index], m.servers[index+1:]...)
		return true
	}

	return false
}

func isPermanentToolCatalogRefreshError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) || errors.Is(err, os.ErrClosed) {
		return true
	}

	message := err.Error()
	return strings.Contains(message, "child process exited (stdout closed)") ||
		strings.Contains(message, "file already closed") ||
		strings.Contains(message, "broken pipe")
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
