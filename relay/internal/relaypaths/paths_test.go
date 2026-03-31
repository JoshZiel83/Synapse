package relaypaths

import (
	"path/filepath"
	"testing"
)

func TestResolveStandaloneProfileUsesFixedProfileID(t *testing.T) {
	hostPaths := HostPaths{
		HostKind:     HostStandalone,
		SharedRoot:   filepath.Join(string(filepath.Separator), "tmp", "shared"),
		ProfilesRoot: filepath.Join(string(filepath.Separator), "tmp", "profiles"),
	}

	paths := ResolveStandaloneProfile(hostPaths)

	if paths.ProfileID != "standalone-default" {
		t.Fatalf("expected standalone profile id, got %q", paths.ProfileID)
	}
	if got := filepath.Base(paths.ConfigPath); got != "config.yaml" {
		t.Fatalf("expected config file name config.yaml, got %q", got)
	}
	if got := filepath.Dir(paths.ConfigPath); got != paths.ProfileRoot {
		t.Fatalf("expected config path under profile root, got %q vs %q", got, paths.ProfileRoot)
	}
}

func TestIMProfileIDIsStableAndScoped(t *testing.T) {
	first := IMProfileID("https://relay.example", "user-1", "workspace-1")
	second := IMProfileID("https://relay.example", "user-1", "workspace-1")
	third := IMProfileID("https://relay.example", "user-2", "workspace-1")

	if first != second {
		t.Fatalf("expected stable IM profile id, got %q and %q", first, second)
	}
	if first == third {
		t.Fatalf("expected different user to change IM profile id, got %q", first)
	}
}
