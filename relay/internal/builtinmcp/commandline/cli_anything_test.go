package commandline

import (
	"os"
	"path/filepath"
	"runtime"
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

func TestResolveExistingPathExpandsTilde(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	targetPath := filepath.Join(homeDir, "Applications", "Demo.app", "Contents", "MacOS", "demo")
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		t.Fatalf("mkdirs: %v", err)
	}
	if err := os.WriteFile(targetPath, []byte("demo"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	got := resolveExistingPath("~/Applications/Demo.app/Contents/MacOS/demo")
	if got != targetPath {
		t.Fatalf("expected expanded path %q, got %q", targetPath, got)
	}
}

func TestResolveExecutableFromAugmentedSearchPathsFindsMacStyleTool(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	toolPath := filepath.Join(homeDir, "bin", "demo-tool")
	if err := os.MkdirAll(filepath.Dir(toolPath), 0755); err != nil {
		t.Fatalf("mkdirs: %v", err)
	}
	if err := os.WriteFile(toolPath, []byte("demo"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	got := resolveExecutableFromAugmentedSearchPaths("demo-tool")
	if runtime.GOOS != "darwin" {
		t.Skip("darwin-only augmented PATH search is disabled on non-darwin builds")
	}
	if got != toolPath {
		t.Fatalf("expected augmented search path %q, got %q", toolPath, got)
	}
}
