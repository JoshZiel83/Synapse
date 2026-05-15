package vfs

import (
	"context"
	"testing"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/cloud"
	"github.com/PekingSpades/Synapse/relay/internal/mcp"
)

type fakeManager struct {
	initCtx    context.Context
	shutdowns  int
	serverInfo []mcp.ServerInfo
}

func (m *fakeManager) InitAll(ctx context.Context) error {
	m.initCtx = ctx
	return nil
}

func (m *fakeManager) GetServerInfo() []mcp.ServerInfo {
	return append([]mcp.ServerInfo(nil), m.serverInfo...)
}

func (m *fakeManager) ShutdownAll() {
	m.shutdowns++
}

func (m *fakeManager) CallTool(context.Context, string, string, map[string]interface{}) (interface{}, error) {
	return nil, nil
}

func (m *fakeManager) OpenRuntimeSession(context.Context, cloud.RuntimeSessionRequest) error {
	return nil
}

func (m *fakeManager) CloseRuntimeSession(context.Context, string) error {
	return nil
}

func TestManagerBackendKeepsLifetimeContextUntilClose(t *testing.T) {
	manager := &fakeManager{
		serverInfo: []mcp.ServerInfo{
			{
				StableKey: "demo",
				Name:      "demo",
				Metadata: map[string]interface{}{
					"builtinKind": "browser",
				},
			},
		},
	}

	backend := &managerBackend{mgr: manager}
	if err := backend.Start(context.Background()); err != nil {
		t.Fatalf("Start() error: %v", err)
	}
	if manager.initCtx == nil {
		t.Fatalf("InitAll context was not captured")
	}

	select {
	case <-manager.initCtx.Done():
		t.Fatalf("InitAll context was canceled before Close()")
	default:
	}

	backend.Close()

	select {
	case <-manager.initCtx.Done():
	case <-time.After(time.Second):
		t.Fatalf("InitAll context was not canceled by Close()")
	}

	if manager.shutdowns != 1 {
		t.Fatalf("ShutdownAll calls = %d, want 1", manager.shutdowns)
	}
}
