package mcp

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/config"
)

func TestManagerNotifyCatalogHintEmitsEventAndSignal(t *testing.T) {
	manager := NewManager(nil)
	eventCh := make(chan struct {
		evtType string
		msg     string
		data    map[string]interface{}
	}, 1)

	manager.OnEvent = func(evtType string, msg string, data map[string]interface{}) {
		eventCh <- struct {
			evtType string
			msg     string
			data    map[string]interface{}
		}{evtType: evtType, msg: msg, data: data}
	}

	manager.notifyCatalogHint("demo-server", "stable-demo")

	select {
	case <-manager.CatalogHints():
	default:
		t.Fatalf("expected catalog hint signal to be emitted")
	}

	select {
	case evt := <-eventCh:
		if evt.evtType != "catalog_hint" {
			t.Fatalf("expected catalog_hint event, got %q", evt.evtType)
		}
		if evt.data["server"] != "demo-server" {
			t.Fatalf("expected server name in event data")
		}
		if evt.data["stableKey"] != "stable-demo" {
			t.Fatalf("expected stableKey in event data")
		}
	default:
		t.Fatalf("expected catalog_hint event to be emitted")
	}
}

type failingServer struct {
	listToolsErr error
	shutdowns    int
}

func (s *failingServer) Start(context.Context) error {
	return nil
}

func (s *failingServer) Initialize() error {
	return nil
}

func (s *failingServer) ListTools() ([]Tool, error) {
	return nil, s.listToolsErr
}

func (s *failingServer) CallTool(context.Context, string, map[string]interface{}) (interface{}, error) {
	return nil, nil
}

func (s *failingServer) Shutdown() {
	s.shutdowns++
}

type temporaryTestError struct {
	message string
}

func (e temporaryTestError) Error() string {
	return e.message
}

func (e temporaryTestError) Temporary() bool {
	return true
}

type scriptedServer struct {
	startFn      func(context.Context) error
	initializeFn func() error
	listToolsFn  func() ([]Tool, error)
	shutdownFn   func()
}

func (s *scriptedServer) Start(ctx context.Context) error {
	if s.startFn != nil {
		return s.startFn(ctx)
	}
	return nil
}

func (s *scriptedServer) Initialize() error {
	if s.initializeFn != nil {
		return s.initializeFn()
	}
	return nil
}

func (s *scriptedServer) ListTools() ([]Tool, error) {
	if s.listToolsFn != nil {
		return s.listToolsFn()
	}
	return nil, nil
}

func (s *scriptedServer) CallTool(context.Context, string, map[string]interface{}) (interface{}, error) {
	return nil, nil
}

func (s *scriptedServer) Shutdown() {
	if s.shutdownFn != nil {
		s.shutdownFn()
	}
}

func TestRefreshToolCatalogsRemovesPermanentlyClosedServer(t *testing.T) {
	dead := &failingServer{listToolsErr: errors.New("send tools/list: write |1: file already closed")}
	live := &failingServer{}
	manager := NewManager(nil)
	manager.servers = []serverEntry{
		{
			stableKey: "dead",
			name:      "chrome-browser",
			cfg: config.ServerConfig{
				StableKey: "dead",
				Name:      "chrome-browser",
				Transport: "builtin",
			},
			server: dead,
			tools: []Tool{
				{Name: "open_tab"},
			},
		},
		{
			stableKey: "live",
			name:      "filesystem",
			cfg: config.ServerConfig{
				StableKey: "live",
				Name:      "filesystem",
				Transport: "builtin",
			},
			server: live,
			tools: []Tool{
				{Name: "read_file"},
			},
		},
	}

	changed, servers, err := manager.RefreshToolCatalogs(context.Background())
	if err != nil {
		t.Fatalf("expected refresh to succeed, got %v", err)
	}
	if !changed {
		t.Fatalf("expected dead server removal to mark catalog as changed")
	}
	if dead.shutdowns != 1 {
		t.Fatalf("expected dead server to be shut down once, got %d", dead.shutdowns)
	}
	if len(servers) != 1 || servers[0].StableKey != "live" {
		t.Fatalf("expected only live server to remain, got %+v", servers)
	}
	if manager.PendingServerCount() != 1 {
		t.Fatalf("expected dead server to move into pending state")
	}
}

func TestInitAllKeepsRetryableServerPendingUntilRefreshActivatesIt(t *testing.T) {
	cfg := config.ServerConfig{
		StableKey: "command-line",
		Name:      "command-line",
		Transport: "builtin",
	}

	manager := NewManager([]config.ServerConfig{cfg})
	attempts := 0
	manager.newServer = func(cfg config.ServerConfig) (Server, error) {
		return &scriptedServer{
			startFn: func(context.Context) error {
				attempts++
				if attempts == 1 {
					return temporaryTestError{message: "warming runtime"}
				}
				return nil
			},
			listToolsFn: func() ([]Tool, error) {
				return []Tool{{Name: "bash_exec"}}, nil
			},
		}, nil
	}

	if err := manager.InitAll(context.Background()); err != nil {
		t.Fatalf("expected init to tolerate pending server, got %v", err)
	}
	if len(manager.GetServerInfo()) != 0 {
		t.Fatalf("expected no active servers until retry succeeds")
	}
	if manager.PendingServerCount() != 1 {
		t.Fatalf("expected one pending server after init")
	}

	manager.pending[cfg.StableKey].nextRetryAt = time.Now().Add(-time.Second)

	changed, servers, err := manager.RefreshToolCatalogs(context.Background())
	if err != nil {
		t.Fatalf("expected refresh to succeed, got %v", err)
	}
	if !changed {
		t.Fatalf("expected pending activation to mark catalog as changed")
	}
	if len(servers) != 1 || servers[0].StableKey != cfg.StableKey {
		t.Fatalf("expected pending server to activate, got %+v", servers)
	}
	if manager.PendingServerCount() != 0 {
		t.Fatalf("expected pending server to be cleared after activation")
	}
}
