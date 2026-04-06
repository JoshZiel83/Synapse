//go:build windows

package cloud

import (
	"strings"
	"testing"
)

func TestBuildWindowsUpdateLauncherScriptWaitsForAppExit(t *testing.T) {
	t.Parallel()

	script := buildWindowsUpdateLauncherScript(`C:\Temp\relay-update.exe`, "/S /AUTOLAUNCH=1")

	if !strings.Contains(script, `tasklist /FI "IMAGENAME eq synapse-relay-gui.exe" | find /I "synapse-relay-gui.exe" >nul`) {
		t.Fatalf("expected script to probe for the running GUI process, got:\n%s", script)
	}
	if !strings.Contains(script, "if errorlevel 1 goto install") {
		t.Fatalf("expected script to continue once the GUI process exits, got:\n%s", script)
	}
	if !strings.Contains(script, `start "" /wait "C:\Temp\relay-update.exe" /S /AUTOLAUNCH=1`) {
		t.Fatalf("expected script to launch the installer with the requested arguments, got:\n%s", script)
	}
}
