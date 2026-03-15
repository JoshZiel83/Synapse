package relay

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/cloud"
	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/mcp"
)

// State represents the relay engine lifecycle state
type State string

const (
	StateStopped  State = "stopped"
	StateStarting State = "starting"
	StateRunning  State = "running"
	StateStopping State = "stopping"
	StateError    State = "error"
)

const catalogRefreshInterval = 10 * time.Second

// Engine orchestrates the relay lifecycle: MCP servers + cloud connection
type Engine struct {
	cfg           *config.Config
	mgr           *mcp.Manager
	client        *cloud.Client
	clientVersion string
	state         State
	cancel        context.CancelFunc
	listeners     []EventListener
	lastErr       error
	beforeConnect func(context.Context) error
	mu            sync.RWMutex
	done          chan struct{}
}

// New creates a new relay engine with the given config
func New(cfg *config.Config) *Engine {
	return &Engine{
		cfg:   cfg,
		state: StateStopped,
	}
}

// OnEvent registers an event listener
func (e *Engine) OnEvent(listener EventListener) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.listeners = append(e.listeners, listener)
}

func (e *Engine) SetBeforeConnect(handler func(context.Context) error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.beforeConnect = handler
}

func (e *Engine) SetClientVersion(version string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.clientVersion = version
}

func (e *Engine) emit(evt Event) {
	e.mu.RLock()
	listeners := make([]EventListener, len(e.listeners))
	copy(listeners, e.listeners)
	e.mu.RUnlock()

	for _, l := range listeners {
		l(evt)
	}
}

// Start begins the relay engine in a background goroutine.
// Non-blocking — returns immediately. Use Wait() to block until stopped.
func (e *Engine) Start(ctx context.Context) error {
	e.mu.Lock()
	if e.state == StateRunning || e.state == StateStarting {
		e.mu.Unlock()
		return fmt.Errorf("engine already running")
	}
	if errs := config.Validate(e.cfg); len(errs) > 0 {
		e.mu.Unlock()
		return fmt.Errorf("invalid config: %s", errs[0])
	}
	e.state = StateStarting
	e.lastErr = nil
	e.done = make(chan struct{})
	e.mu.Unlock()

	e.emit(NewEvent(EventStateChanged, "starting"))

	childCtx, cancel := context.WithCancel(ctx)
	e.mu.Lock()
	e.cancel = cancel
	e.mu.Unlock()

	go e.run(childCtx)
	return nil
}

func (e *Engine) run(ctx context.Context) {
	defer close(e.done)

	// Initialize MCP servers
	e.emit(NewEvent(EventLog, "Initializing MCP servers..."))
	mgr := mcp.NewManager(e.cfg.Servers)

	// Wire event callback to manager
	mgr.OnEvent = func(evtType string, msg string, data map[string]interface{}) {
		evt := NewEvent(EventType(evtType), msg)
		evt.Data = data
		e.emit(evt)
	}

	if err := mgr.InitAll(ctx); err != nil {
		e.mu.Lock()
		e.state = StateError
		e.lastErr = err
		e.mu.Unlock()
		e.emit(NewEvent(EventError, fmt.Sprintf("Failed to initialize MCP servers: %v", err)))
		e.emit(NewEvent(EventStateChanged, "error"))
		return
	}

	e.mu.Lock()
	e.mgr = mgr
	e.mu.Unlock()

	servers := mgr.GetServerInfo()
	e.emit(NewEvent(EventServersReady, fmt.Sprintf("Discovered %d MCP servers", len(servers))))

	for _, s := range servers {
		log.Printf("  - %s (%s): %d tools", s.Name, s.Transport, len(s.Tools))
	}

	// Connect to cloud
	client := cloud.NewClient(e.cfg.Relay, mgr)
	client.SetSyncSources(e.cfg.SyncSources)
	client.SetExposures(servers)
	client.BeforeConnect = e.beforeConnect
	client.SetClientVersion(e.clientVersion)

	// Wire event callback to client
	client.OnEvent = func(evtType string, msg string, data map[string]interface{}) {
		evt := NewEvent(EventType(evtType), msg)
		evt.Data = data
		e.emit(evt)
	}

	e.mu.Lock()
	e.client = client
	e.state = StateRunning
	e.mu.Unlock()

	e.emit(NewEvent(EventStateChanged, "running"))

	go e.watchCatalog(ctx, mgr, client)

	err := client.Run(ctx)

	// Shutdown MCP servers
	mgr.ShutdownAll()

	e.mu.Lock()
	e.mgr = nil
	e.client = nil
	if ctx.Err() != nil {
		e.state = StateStopped
	} else if err != nil {
		e.state = StateError
		e.lastErr = err
	} else {
		e.state = StateStopped
	}
	e.mu.Unlock()

	e.emit(NewEvent(EventStateChanged, string(e.State())))
}

// Stop gracefully stops the engine
func (e *Engine) Stop() error {
	e.mu.Lock()
	if e.state != StateRunning && e.state != StateStarting {
		e.mu.Unlock()
		return fmt.Errorf("engine not running")
	}
	e.state = StateStopping
	cancel := e.cancel
	e.mu.Unlock()

	e.emit(NewEvent(EventStateChanged, "stopping"))

	if cancel != nil {
		cancel()
	}

	// Wait for run goroutine to finish
	if e.done != nil {
		<-e.done
	}

	return nil
}

// Restart stops and restarts the engine with the current config
func (e *Engine) Restart() error {
	if e.State() == StateRunning || e.State() == StateStarting {
		if err := e.Stop(); err != nil {
			return fmt.Errorf("stop: %w", err)
		}
	}
	return e.Start(context.Background())
}

// State returns the current engine state
func (e *Engine) State() State {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.state
}

// LastError returns the last error that occurred
func (e *Engine) LastError() error {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.lastErr
}

// ServerInfo returns info about initialized servers
func (e *Engine) ServerInfo() []mcp.ServerInfo {
	e.mu.RLock()
	mgr := e.mgr
	e.mu.RUnlock()
	if mgr == nil {
		return nil
	}
	return mgr.GetServerInfo()
}

// UpdateConfig updates the engine config (takes effect on next Start/Restart)
func (e *Engine) UpdateConfig(cfg *config.Config) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg = cfg
}

// Wait blocks until the engine stops
func (e *Engine) Wait() {
	if e.done != nil {
		<-e.done
	}
}

func (e *Engine) watchCatalog(ctx context.Context, mgr *mcp.Manager, client *cloud.Client) {
	ticker := time.NewTicker(catalogRefreshInterval)
	defer ticker.Stop()
	hintCh := mgr.CatalogHints()

	for {
		select {
		case <-ctx.Done():
			return
		case <-hintCh:
			e.emit(NewEvent(EventCatalogHint, "Received MCP tools/list_changed notification"))
			e.refreshCatalog(ctx, mgr, client)
		case <-ticker.C:
			e.refreshCatalog(ctx, mgr, client)
		}
	}
}

func (e *Engine) refreshCatalog(ctx context.Context, mgr *mcp.Manager, client *cloud.Client) {
	changed, servers, err := mgr.RefreshToolCatalogs()
	if err != nil {
		e.emit(NewEvent(EventError, fmt.Sprintf("Failed to refresh MCP catalog: %v", err)))
		return
	}
	if !changed {
		return
	}

	client.SetExposures(servers)
	syncCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	err = client.SyncCatalog(syncCtx)
	cancel()
	if err != nil {
		e.emit(NewEvent(EventLog, fmt.Sprintf("Tool catalog changed locally; server sync will retry on reconnect: %v", err)))
		return
	}

	e.emit(NewEvent(EventCatalogChanged, fmt.Sprintf("Updated relay catalog with %d MCP servers", len(servers))))
}
