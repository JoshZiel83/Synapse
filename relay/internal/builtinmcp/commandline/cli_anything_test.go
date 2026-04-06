package commandline

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/PekingSpades/Synapse/relay/internal/commandlinebundle"
)

func TestResolveCliAnythingWrapperPathFindsManagedWrapper(t *testing.T) {
	managedBinDir := t.TempDir()
	wrapperPath := filepath.Join(managedBinDir, "cli-anything-demo")
	if err := os.WriteFile(wrapperPath, []byte("#!/usr/bin/env bash\n"), 0644); err != nil {
		t.Fatalf("write wrapper: %v", err)
	}

	server := &Server{
		installation: &commandlinebundle.Installation{
			ManagedBinDir: managedBinDir,
		},
	}

	got := server.resolveCliAnythingWrapperPath("cli-anything-demo")
	if got != wrapperPath {
		t.Fatalf("expected wrapper path %q, got %q", wrapperPath, got)
	}
}
