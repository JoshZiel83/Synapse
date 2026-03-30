package desktopdiag

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStartReportsPreviousUnexpectedExitOnSameBoot(t *testing.T) {
	previousBaseDir := defaultBaseDir
	previousBootID := currentBootID
	previousNow := now
	t.Cleanup(func() {
		defaultBaseDir = previousBaseDir
		currentBootID = previousBootID
		now = previousNow
	})

	baseDir := t.TempDir()
	defaultBaseDir = func() string { return baseDir }
	currentBootID = func() (string, error) { return "boot-123", nil }
	currentTime := time.Date(2026, 3, 30, 2, 3, 4, 0, time.UTC)
	now = func() time.Time { return currentTime }

	stateDir := filepath.Join(baseDir, "state")
	if err := os.MkdirAll(stateDir, 0755); err != nil {
		t.Fatalf("create state dir: %v", err)
	}
	if err := writeJSONAtomic(filepath.Join(stateDir, sessionFileName), &sessionRecord{
		SchemaVersion: 1,
		SessionID:     "previous-session",
		PID:           1234,
		Version:       "v1.2.3",
		BootID:        "boot-123",
		StartedAt:     currentTime.Add(-5 * time.Minute).Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatalf("write previous session: %v", err)
	}

	manager, report, err := Start("v1.2.4")
	if err != nil {
		t.Fatalf("start diagnostics: %v", err)
	}
	if manager == nil {
		t.Fatalf("expected manager")
	}
	if report == nil {
		t.Fatalf("expected crash report")
	}
	if report.SessionID != "previous-session" {
		t.Fatalf("expected previous session id, got %q", report.SessionID)
	}
	if report.LogFile == "" || report.LogsDir == "" {
		t.Fatalf("expected crash report log paths")
	}
}

func TestStartSuppressesCrashReportAfterReboot(t *testing.T) {
	previousBaseDir := defaultBaseDir
	previousBootID := currentBootID
	previousNow := now
	t.Cleanup(func() {
		defaultBaseDir = previousBaseDir
		currentBootID = previousBootID
		now = previousNow
	})

	baseDir := t.TempDir()
	defaultBaseDir = func() string { return baseDir }
	currentBootID = func() (string, error) { return "boot-new", nil }
	now = func() time.Time { return time.Date(2026, 3, 30, 2, 3, 4, 0, time.UTC) }

	stateDir := filepath.Join(baseDir, "state")
	if err := os.MkdirAll(stateDir, 0755); err != nil {
		t.Fatalf("create state dir: %v", err)
	}
	if err := writeJSONAtomic(filepath.Join(stateDir, sessionFileName), &sessionRecord{
		SchemaVersion: 1,
		SessionID:     "previous-session",
		PID:           1234,
		Version:       "v1.2.3",
		BootID:        "boot-old",
		StartedAt:     now().Add(-5 * time.Minute).Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatalf("write previous session: %v", err)
	}

	_, report, err := Start("v1.2.4")
	if err != nil {
		t.Fatalf("start diagnostics: %v", err)
	}
	if report != nil {
		t.Fatalf("expected no crash report after reboot, got %+v", report)
	}
}
