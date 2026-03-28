package runtimeauth

import "testing"

func TestSessionGrantsAreScopedToRuntimeSession(t *testing.T) {
	store := NewStore(t.TempDir() + "/runtime-auth.json")

	if err := store.OpenSession(RuntimeSession{
		ID:                "session-a",
		ExposureStableKey: "filesystem-demo",
	}); err != nil {
		t.Fatalf("open session-a: %v", err)
	}
	if err := store.OpenSession(RuntimeSession{
		ID:                "session-b",
		ExposureStableKey: "filesystem-demo",
	}); err != nil {
		t.Fatalf("open session-b: %v", err)
	}

	if err := store.Apply(Grant{
		InteractionID:     "persistent-1",
		ExposureStableKey: "filesystem-demo",
		Duration:          "persistent",
		Capability:        "filesystem",
		Path:              "/shared",
		Access:            "read",
	}); err != nil {
		t.Fatalf("apply persistent grant: %v", err)
	}
	if err := store.Apply(Grant{
		InteractionID:     "session-1",
		RuntimeSessionID:  "session-a",
		ExposureStableKey: "filesystem-demo",
		Duration:          "session",
		Capability:        "filesystem",
		Path:              "/shared/private",
		Access:            "read_write",
	}); err != nil {
		t.Fatalf("apply session grant: %v", err)
	}

	noSession := store.FilesystemGrants("filesystem-demo", "")
	if len(noSession) != 1 || noSession[0].Path != "/shared" {
		t.Fatalf("expected only persistent grant without runtime session, got %+v", noSession)
	}

	sessionA := store.FilesystemGrants("filesystem-demo", "session-a")
	if len(sessionA) != 2 {
		t.Fatalf("expected persistent + session grant for session-a, got %+v", sessionA)
	}

	sessionB := store.FilesystemGrants("filesystem-demo", "session-b")
	if len(sessionB) != 1 || sessionB[0].Path != "/shared" {
		t.Fatalf("expected only persistent grant for session-b, got %+v", sessionB)
	}

	store.CloseSession("session-a")

	afterClose := store.FilesystemGrants("filesystem-demo", "session-a")
	if len(afterClose) != 1 || afterClose[0].Path != "/shared" {
		t.Fatalf("expected session grants to be removed after close, got %+v", afterClose)
	}
}

func TestResetSessionsKeepsPersistentGrantsButClearsSessionState(t *testing.T) {
	store := NewStore(t.TempDir() + "/runtime-auth.json")

	if err := store.OpenSession(RuntimeSession{
		ID:                "session-cua",
		ExposureStableKey: "cua-demo",
	}); err != nil {
		t.Fatalf("open session: %v", err)
	}
	if err := store.Apply(Grant{
		InteractionID:     "persistent-cua",
		ExposureStableKey: "cua-demo",
		Duration:          "persistent",
		Capability:        "cua",
		Mode:              "control",
	}); err != nil {
		t.Fatalf("apply persistent cua grant: %v", err)
	}
	if err := store.Apply(Grant{
		InteractionID:     "session-cua",
		RuntimeSessionID:  "session-cua",
		ExposureStableKey: "cua-demo",
		Duration:          "session",
		Capability:        "cua",
		Mode:              "control",
	}); err != nil {
		t.Fatalf("apply session cua grant: %v", err)
	}

	if !store.AllowsCUAControl("cua-demo", "session-cua") {
		t.Fatalf("expected cua control before reset")
	}

	store.ResetSessions()

	if !store.AllowsCUAControl("cua-demo", "") {
		t.Fatalf("expected persistent cua control to remain after reset")
	}
	if !store.AllowsCUAControl("cua-demo", "session-cua") {
		t.Fatalf("expected persistent cua control to remain visible after reset")
	}
}

func TestSessionGrantRequiresMatchingOpenSession(t *testing.T) {
	store := NewStore(t.TempDir() + "/runtime-auth.json")

	if err := store.OpenSession(RuntimeSession{
		ID:                "session-x",
		ExposureStableKey: "filesystem-demo",
	}); err != nil {
		t.Fatalf("open session: %v", err)
	}

	err := store.Apply(Grant{
		InteractionID:     "session-wrong-exposure",
		RuntimeSessionID:  "session-x",
		ExposureStableKey: "other-exposure",
		Duration:          "session",
		Capability:        "filesystem",
		Path:              "/tmp/demo",
		Access:            "read",
	})
	if err == nil {
		t.Fatalf("expected mismatched exposure session grant to fail")
	}

	err = store.Apply(Grant{
		InteractionID:     "session-missing",
		RuntimeSessionID:  "missing-session",
		ExposureStableKey: "filesystem-demo",
		Duration:          "session",
		Capability:        "filesystem",
		Path:              "/tmp/demo",
		Access:            "read",
	})
	if err == nil {
		t.Fatalf("expected missing session grant to fail")
	}
}

func TestChromeAuthorizationIsPersistentOnly(t *testing.T) {
	store := NewStore(t.TempDir() + "/runtime-auth.json")

	err := store.Apply(Grant{
		InteractionID:     "chrome-session",
		ExposureStableKey: "chrome-demo",
		Duration:          "session",
		Capability:        "chrome",
	})
	if err == nil {
		t.Fatalf("expected session-scoped chrome authorization to fail")
	}

	if err := store.Apply(Grant{
		InteractionID:     "chrome-persistent",
		ExposureStableKey: "chrome-demo",
		Duration:          "persistent",
		Capability:        "chrome",
	}); err != nil {
		t.Fatalf("apply persistent chrome grant: %v", err)
	}

	if !store.AllowsChromeAutomation("chrome-demo") {
		t.Fatalf("expected persistent chrome authorization to be available")
	}
}
