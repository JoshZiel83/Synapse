package mcp

import (
	"context"
	"errors"
	"testing"
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

func TestRefreshToolCatalogsRemovesPermanentlyClosedServer(t *testing.T) {
	dead := &failingServer{listToolsErr: errors.New("send tools/list: write |1: file already closed")}
	live := &failingServer{}
	manager := NewManager(nil)
	manager.servers = []serverEntry{
		{
			stableKey: "dead",
			name:      "chrome-browser",
			server:    dead,
			tools: []Tool{
				{Name: "open_tab"},
			},
		},
		{
			stableKey: "live",
			name:      "filesystem",
			server:    live,
			tools: []Tool{
				{Name: "read_file"},
			},
		},
	}

	changed, servers, err := manager.RefreshToolCatalogs()
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
}
