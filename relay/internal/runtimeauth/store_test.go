package runtimeauth

import (
	"context"
	"testing"
)

func TestContextWithRuntimeSessionIDRoundTripsValue(t *testing.T) {
	ctx := ContextWithRuntimeSessionID(context.Background(), "session-a")
	if got := RuntimeSessionIDFromContext(ctx); got != "session-a" {
		t.Fatalf("expected runtime session id to round-trip, got %q", got)
	}
}

func TestContextWithRuntimeSessionIDIgnoresEmptyValue(t *testing.T) {
	base := context.Background()
	ctx := ContextWithRuntimeSessionID(base, "")
	if ctx != base {
		t.Fatalf("expected empty runtime session id to leave context unchanged")
	}
	if got := RuntimeSessionIDFromContext(ctx); got != "" {
		t.Fatalf("expected empty runtime session id, got %q", got)
	}
	if got := RuntimeSessionIDFromContext(nil); got != "" {
		t.Fatalf("expected nil context to return empty runtime session id, got %q", got)
	}
}

func TestContextWithRuntimeAuthorizationRoundTripsValue(t *testing.T) {
	authorization := RuntimeAuthorization{
		GrantIDs:   []string{"grant-1", "grant-2"},
		GrantScope: "persistent",
		RetryNonce: "nonce-1",
		GrantSpecs: []map[string]interface{}{
			{
				"kind": "cua.tool",
			},
			{
				"kind": "cua.write",
			},
		},
	}
	ctx := ContextWithRuntimeAuthorization(context.Background(), authorization)
	got := RuntimeAuthorizationFromContext(ctx)
	if len(got.GrantIDs) != len(authorization.GrantIDs) || got.GrantScope != authorization.GrantScope || got.RetryNonce != authorization.RetryNonce {
		t.Fatalf("expected runtime authorization metadata to round-trip, got %+v", got)
	}
	if len(got.GrantSpecs) != 2 || got.GrantSpecs[1]["kind"] != "cua.write" {
		t.Fatalf("expected runtime authorization grant specs to round-trip, got %+v", got.GrantSpecs)
	}
	if !got.IsServerAuthorized() {
		t.Fatalf("expected runtime authorization to report server authorization")
	}
}

func TestContextWithRuntimeAuthorizationIgnoresEmptyValue(t *testing.T) {
	base := context.Background()
	ctx := ContextWithRuntimeAuthorization(base, RuntimeAuthorization{})
	if ctx != base {
		t.Fatalf("expected empty runtime authorization to leave context unchanged")
	}
	got := RuntimeAuthorizationFromContext(ctx)
	if len(got.GrantIDs) != 0 || got.GrantScope != "" || got.RetryNonce != "" || len(got.GrantSpecs) != 0 {
		t.Fatalf("expected empty runtime authorization, got %+v", got)
	}
	if got := RuntimeAuthorizationFromContext(nil); len(got.GrantIDs) != 0 || got.GrantScope != "" || got.RetryNonce != "" || len(got.GrantSpecs) != 0 {
		t.Fatalf("expected nil context to return empty runtime authorization, got %+v", got)
	}
}
