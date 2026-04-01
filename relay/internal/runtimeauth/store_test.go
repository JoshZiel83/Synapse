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
		GrantID:    "grant-1",
		GrantScope: "persistent",
		RetryNonce: "nonce-1",
		Effect: map[string]interface{}{
			"capability": "cua",
			"mode":       "control",
		},
	}
	ctx := ContextWithRuntimeAuthorization(context.Background(), authorization)
	got := RuntimeAuthorizationFromContext(ctx)
	if got.GrantID != authorization.GrantID || got.GrantScope != authorization.GrantScope || got.RetryNonce != authorization.RetryNonce {
		t.Fatalf("expected runtime authorization metadata to round-trip, got %+v", got)
	}
	if got.Effect["capability"] != "cua" || got.Effect["mode"] != "control" {
		t.Fatalf("expected runtime authorization effect to round-trip, got %+v", got.Effect)
	}
}

func TestContextWithRuntimeAuthorizationIgnoresEmptyValue(t *testing.T) {
	base := context.Background()
	ctx := ContextWithRuntimeAuthorization(base, RuntimeAuthorization{})
	if ctx != base {
		t.Fatalf("expected empty runtime authorization to leave context unchanged")
	}
	got := RuntimeAuthorizationFromContext(ctx)
	if got.GrantID != "" || got.GrantScope != "" || got.RetryNonce != "" || len(got.Effect) != 0 {
		t.Fatalf("expected empty runtime authorization, got %+v", got)
	}
	if got := RuntimeAuthorizationFromContext(nil); got.GrantID != "" || got.GrantScope != "" || got.RetryNonce != "" || len(got.Effect) != 0 {
		t.Fatalf("expected nil context to return empty runtime authorization, got %+v", got)
	}
}
