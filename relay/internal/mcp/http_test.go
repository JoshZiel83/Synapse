package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestHTTPServerEventStreamTriggersToolsListChanged(t *testing.T) {
	var getCount atomic.Int32
	notifications := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	client := NewHTTPServer("http://relay.test/mcp")
	client.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.Method {
		case http.MethodPost:
			switch requestMethod(t, r) {
			case "initialize":
				return jsonResponse(http.StatusOK, "session-1", `{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"demo","version":"1.0.0"}}}`), nil
			case "notifications/initialized":
				return jsonResponse(http.StatusAccepted, "session-1", ``), nil
			case "tools/list":
				if got := r.Header.Get("Mcp-Session-Id"); got != "session-1" {
					t.Fatalf("expected session header on tools/list, got %q", got)
				}
				return jsonResponse(http.StatusOK, "session-1", `{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}`), nil
			default:
				t.Fatalf("unexpected POST method")
			}
		case http.MethodGet:
			getCount.Add(1)
			if got := r.Header.Get("Mcp-Session-Id"); got != "session-1" {
				t.Fatalf("expected session header on SSE stream, got %q", got)
			}
			pr, pw := io.Pipe()
			go func() {
				_, _ = fmt.Fprint(pw, "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n")
				select {
				case notifications <- struct{}{}:
				default:
				}
				<-r.Context().Done()
				_ = pw.Close()
			}()
			return &http.Response{
				StatusCode: http.StatusOK,
				Header: http.Header{
					"Content-Type":   []string{"text/event-stream"},
					"Mcp-Session-Id": []string{"session-1"},
				},
				Body: pr,
			}, nil
		default:
			t.Fatalf("unexpected HTTP method %s", r.Method)
			return nil, nil
		}
		return nil, nil
	})

	changed := make(chan struct{}, 1)
	client.SetToolsChangedHandler(func() {
		select {
		case changed <- struct{}{}:
		default:
		}
	})

	if err := client.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := client.Initialize(); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if _, err := client.ListTools(); err != nil {
		t.Fatalf("list tools: %v", err)
	}

	select {
	case <-notifications:
	case <-time.After(2 * time.Second):
		t.Fatalf("expected SSE stream to connect")
	}

	select {
	case <-changed:
	case <-time.After(2 * time.Second):
		t.Fatalf("expected tools/list_changed notification")
	}

	if getCount.Load() == 0 {
		t.Fatalf("expected SSE GET stream to be opened")
	}

	client.Shutdown()
}

func TestHTTPServerParsesSSEResponseAndNotification(t *testing.T) {
	server := NewHTTPServer("http://example.invalid")
	changed := make(chan struct{}, 1)
	server.SetToolsChangedHandler(func() {
		select {
		case changed <- struct{}{}:
		default:
		}
	})

	stream := strings.NewReader(
		"data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n" +
			"data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"tools\":[{\"name\":\"search\",\"description\":\"demo\"}]}}\n\n",
	)

	var result ToolsListResult
	if err := server.parseSSEResponse(stream, &result); err != nil {
		t.Fatalf("parse SSE response: %v", err)
	}

	select {
	case <-changed:
	case <-time.After(time.Second):
		t.Fatalf("expected notification handler to run")
	}

	if len(result.Result.Tools) != 1 || result.Result.Tools[0].Name != "search" {
		t.Fatalf("unexpected tools list result: %+v", result.Result.Tools)
	}
}

func TestHTTPServerCallToolHonorsContextCancellation(t *testing.T) {
	server := NewHTTPServer("http://relay.test/mcp")
	server.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		<-r.Context().Done()
		return nil, r.Context().Err()
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := server.CallTool(ctx, "search", map[string]interface{}{"q": "demo"})
	if err == nil {
		t.Fatalf("expected call to be cancelled")
	}
	if !strings.Contains(err.Error(), context.Canceled.Error()) {
		t.Fatalf("expected cancelled error, got %v", err)
	}
}

func requestMethod(t *testing.T, r *http.Request) string {
	t.Helper()

	var req struct {
		Method string `json:"method"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	return req.Method
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return fn(r)
}

func jsonResponse(statusCode int, sessionID string, body string) *http.Response {
	header := http.Header{}
	if body != "" {
		header.Set("Content-Type", "application/json")
	}
	if sessionID != "" {
		header.Set("Mcp-Session-Id", sessionID)
	}
	return &http.Response{
		StatusCode: statusCode,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
