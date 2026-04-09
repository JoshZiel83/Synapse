package cloud

import (
	"strings"
	"testing"
)

func TestResolveDarwinAppBundlePath(t *testing.T) {
	t.Parallel()

	appBundlePath := resolveDarwinAppBundlePath("/Applications/Synapse Relay.app/Contents/MacOS/synapse-relay-gui")
	if appBundlePath != "/Applications/Synapse Relay.app" {
		t.Fatalf("expected app bundle path, got %q", appBundlePath)
	}

	if got := resolveDarwinAppBundlePath("/tmp/synapse-relay-gui"); got != "" {
		t.Fatalf("expected non-bundle executable to return empty path, got %q", got)
	}
}

func TestBuildDarwinUpdateLauncherScriptWaitsForAppExit(t *testing.T) {
	t.Parallel()

	script := buildDarwinUpdateLauncherScript(
		"/tmp/Synapse Relay.pkg",
		"/Applications/Synapse Relay.app/Contents/MacOS/synapse-relay-gui",
		true,
	)

	if !strings.Contains(script, `installer_path='/tmp/Synapse Relay.pkg'`) {
		t.Fatalf("expected script to embed the installer path, got:\n%s", script)
	}
	if !strings.Contains(script, `current_executable='/Applications/Synapse Relay.app/Contents/MacOS/synapse-relay-gui'`) {
		t.Fatalf("expected script to embed the current executable path, got:\n%s", script)
	}
	if !strings.Contains(script, `while [ -n "$current_executable" ] && pgrep -f "$current_executable" >/dev/null 2>&1; do`) {
		t.Fatalf("expected script to wait for the running app to exit, got:\n%s", script)
	}
	if !strings.Contains(script, `open -W -n "$installer_path"`) {
		t.Fatalf("expected script to open the installer package and wait for Installer.app, got:\n%s", script)
	}
	if !strings.Contains(script, `open "$app_bundle_path"`) {
		t.Fatalf("expected script to relaunch the app bundle when requested, got:\n%s", script)
	}
}
