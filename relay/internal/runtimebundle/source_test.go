package runtimebundle

import (
	"path/filepath"
	"testing"
)

func TestResolveRootPrefersInstalledRuntimeWhenReady(t *testing.T) {
	previousExecutablePath := executablePath
	t.Cleanup(func() {
		executablePath = previousExecutablePath
	})

	executablePath = func() (string, error) {
		return filepath.Join("C:\\", "Program Files", "Synapse", "Synapse Relay", "synapse-relay-gui.exe"), nil
	}

	userRoot := filepath.Join("C:\\", "Users", "alice", ".synapse-relay", "runtime", "node", "bundle-v1")
	expectedInstalledRoot := filepath.Join("C:\\", "Program Files", "Synapse", "Synapse Relay", "runtime", "node", "bundle-v1")

	root, installed := ResolveRoot(userRoot, func(dir string) bool {
		return dir == expectedInstalledRoot
	}, "runtime", "node", "bundle-v1")

	if !installed {
		t.Fatalf("expected installed runtime to be selected")
	}
	if root != expectedInstalledRoot {
		t.Fatalf("expected installed runtime %q, got %q", expectedInstalledRoot, root)
	}
}

func TestResolveRootFallsBackToUserRootWhenInstalledRuntimeMissing(t *testing.T) {
	previousExecutablePath := executablePath
	t.Cleanup(func() {
		executablePath = previousExecutablePath
	})

	executablePath = func() (string, error) {
		return filepath.Join("C:\\", "Program Files", "Synapse", "Synapse Relay", "synapse-relay-gui.exe"), nil
	}

	userRoot := filepath.Join("C:\\", "Users", "alice", ".synapse-relay", "runtime", "commandline", "bundle-v2")

	root, installed := ResolveRoot(userRoot, func(string) bool {
		return false
	}, "runtime", "commandline", "bundle-v2")

	if installed {
		t.Fatalf("expected missing installed runtime to fall back to user root")
	}
	if root != userRoot {
		t.Fatalf("expected user runtime %q, got %q", userRoot, root)
	}
}
