package runtimebundle

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveRootPrefersInstalledRuntimeWhenReady(t *testing.T) {
	previousExecutablePath := executablePath
	previousLookupEnv := lookupEnv
	t.Cleanup(func() {
		executablePath = previousExecutablePath
		lookupEnv = previousLookupEnv
	})

	lookupEnv = os.LookupEnv
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
	previousLookupEnv := lookupEnv
	t.Cleanup(func() {
		executablePath = previousExecutablePath
		lookupEnv = previousLookupEnv
	})

	lookupEnv = os.LookupEnv
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

func TestPackagedRootUsesMacResourcesDirectory(t *testing.T) {
	previousExecutablePath := executablePath
	previousLookupEnv := lookupEnv
	t.Cleanup(func() {
		executablePath = previousExecutablePath
		lookupEnv = previousLookupEnv
	})

	lookupEnv = os.LookupEnv
	executablePath = func() (string, error) {
		return filepath.Join("/", "Applications", "Synapse Relay.app", "Contents", "MacOS", "Synapse Relay"), nil
	}

	expected := filepath.Join("/", "Applications", "Synapse Relay.app", "Contents", "Resources", "runtime", "node", "bundle-v1")
	if got := PackagedRoot("runtime", "node", "bundle-v1"); got != expected {
		t.Fatalf("expected packaged mac root %q, got %q", expected, got)
	}
}

func TestPackagedRootUsesOverrideEnv(t *testing.T) {
	previousExecutablePath := executablePath
	previousLookupEnv := lookupEnv
	t.Cleanup(func() {
		executablePath = previousExecutablePath
		lookupEnv = previousLookupEnv
	})

	executablePath = func() (string, error) {
		return filepath.Join("/", "Applications", "Synapse Relay.app", "Contents", "MacOS", "Synapse Relay"), nil
	}
	overrideRoot := filepath.Join("/", "tmp", "SynapseRelay.AppDir", "usr", "lib", "synapse-relay-gui")
	lookupEnv = func(key string) (string, bool) {
		if key == packagedRootEnv {
			return overrideRoot, true
		}
		return "", false
	}

	expected := filepath.Join(overrideRoot, "runtime", "commandline", "bundle-v3")
	if got := PackagedRoot("runtime", "commandline", "bundle-v3"); got != expected {
		t.Fatalf("expected packaged override root %q, got %q", expected, got)
	}
}
