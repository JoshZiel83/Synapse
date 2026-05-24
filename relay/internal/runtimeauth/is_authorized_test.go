package runtimeauth

import (
	"context"
	"testing"
)

func ctxWithPolicies(policies ...GrantPolicy) context.Context {
	return ContextWithRuntimeAuthorization(context.Background(), RuntimeAuthorization{
		GrantIDs:   []string{"grant-1"},
		GrantSpecs: policies,
	})
}

func TestIsAuthorizedFilesystem(t *testing.T) {
	ctx := ctxWithPolicies(GrantPolicy{
		Capability: "filesystem",
		Filesystem: &FilesystemPolicy{Access: "read", PathPrefixes: []string{"/tmp"}},
	})
	if !IsAuthorized(ctx, AccessRequest{
		Capability: "filesystem",
		Filesystem: &FilesystemRequest{Access: "read", PathPrefixes: []string{"/tmp/file.txt"}},
	}) {
		t.Fatalf("expected filesystem read under granted prefix to be authorized")
	}
	if IsAuthorized(ctx, AccessRequest{
		Capability: "filesystem",
		Filesystem: &FilesystemRequest{Access: "write", PathPrefixes: []string{"/tmp/file.txt"}},
	}) {
		t.Fatalf("expected filesystem write to be denied when only read is granted")
	}
	if IsAuthorized(ctx, AccessRequest{Capability: "filesystem"}) {
		t.Fatalf("expected nil Filesystem request to be denied")
	}
}

func TestIsAuthorizedCUA(t *testing.T) {
	ctx := ctxWithPolicies(GrantPolicy{
		Capability: "cua",
		CUA:        &CUAPolicy{Access: "write"},
	})
	if !IsAuthorized(ctx, AccessRequest{
		Capability: "cua",
		CUA:        &CUARequest{Access: "write"},
	}) {
		t.Fatalf("expected cua write to be authorized")
	}
	if IsAuthorized(ctx, AccessRequest{
		Capability: "cua",
		CUA:        &CUARequest{Access: "read"},
	}) {
		t.Fatalf("expected cua read to be denied when only write is granted")
	}
	if IsAuthorized(ctx, AccessRequest{Capability: "cua"}) {
		t.Fatalf("expected nil CUA request to be denied")
	}
}

func TestIsAuthorizedBrowser(t *testing.T) {
	ctx := ctxWithPolicies(GrantPolicy{
		Capability: "browser",
		Browser: &BrowserPolicy{
			Action:    "navigate",
			ScopeType: "host",
			Host:      "example.com",
		},
	})
	if !IsAuthorized(ctx, AccessRequest{
		Capability: "browser",
		Browser: &BrowserRequest{
			Action: "navigate",
			Host:   "example.com",
		},
	}) {
		t.Fatalf("expected browser navigate on granted host to be authorized")
	}
	if IsAuthorized(ctx, AccessRequest{
		Capability: "browser",
		Browser: &BrowserRequest{
			Action: "navigate",
			Host:   "other.example",
		},
	}) {
		t.Fatalf("expected browser navigate on non-matching host to be denied")
	}
	if IsAuthorized(ctx, AccessRequest{Capability: "browser"}) {
		t.Fatalf("expected nil Browser request to be denied")
	}
}

func TestIsAuthorizedCommandline(t *testing.T) {
	ctx := ctxWithPolicies(GrantPolicy{
		Capability: "commandline",
		Commandline: &CommandlinePolicy{
			Executor:         "bash",
			CommandMatchType: "prefix",
			CommandText:      "ls",
		},
	})
	if !IsAuthorized(ctx, AccessRequest{
		Capability: "commandline",
		Commandline: &CommandlineRequest{
			Executor: "bash",
			Command:  "ls -la",
		},
	}) {
		t.Fatalf("expected bash `ls -la` to be authorized under `ls` prefix")
	}
	if IsAuthorized(ctx, AccessRequest{
		Capability: "commandline",
		Commandline: &CommandlineRequest{
			Executor: "bash",
			Command:  "rm -rf /",
		},
	}) {
		t.Fatalf("expected bash `rm` to be denied under `ls` prefix")
	}
	if IsAuthorized(ctx, AccessRequest{Capability: "commandline"}) {
		t.Fatalf("expected nil Commandline request to be denied")
	}
}

func TestIsAuthorizedUnknownCapability(t *testing.T) {
	ctx := ctxWithPolicies(GrantPolicy{
		Capability: "cua",
		CUA:        &CUAPolicy{Access: "read"},
	})
	if IsAuthorized(ctx, AccessRequest{Capability: "unknown"}) {
		t.Fatalf("expected unknown capability to be denied")
	}
	if IsAuthorized(ctx, AccessRequest{Capability: ""}) {
		t.Fatalf("expected empty capability to be denied")
	}
}
