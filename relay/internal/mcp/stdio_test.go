package mcp

import "testing"

func TestStdioServerHandleToolsListChangedNotification(t *testing.T) {
	server := NewStdioServer("test", nil, nil)
	called := 0
	server.SetToolsChangedHandler(func() {
		called++
	})

	handled := server.handleNotification([]byte(`{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}`))
	if !handled {
		t.Fatalf("expected tools/list_changed notification to be handled")
	}
	if called != 1 {
		t.Fatalf("expected handler to be called once, got %d", called)
	}
}

func TestStdioServerHandleNotificationIgnoresResponses(t *testing.T) {
	server := NewStdioServer("test", nil, nil)
	called := 0
	server.SetToolsChangedHandler(func() {
		called++
	})

	handled := server.handleNotification([]byte(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`))
	if handled {
		t.Fatalf("expected response message to bypass notification handler")
	}
	if called != 0 {
		t.Fatalf("expected handler not to run for response messages")
	}
}

func TestStdioServerHandleNotificationSwallowsOtherNotifications(t *testing.T) {
	server := NewStdioServer("test", nil, nil)
	called := 0
	server.SetToolsChangedHandler(func() {
		called++
	})

	handled := server.handleNotification([]byte(`{"jsonrpc":"2.0","method":"notifications/progress","params":{"done":1}}`))
	if !handled {
		t.Fatalf("expected generic notification to be swallowed by reader loop")
	}
	if called != 0 {
		t.Fatalf("expected tools/list_changed handler not to run for unrelated notifications")
	}
}
