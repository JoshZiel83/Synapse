package mcp

import "testing"

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
