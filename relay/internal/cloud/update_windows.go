//go:build windows

package cloud

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const windowsUpdateProcessImage = "synapse-relay-gui.exe"

func launchPreparedUpdate(installerPath string, autoLaunch bool) error {
	trimmedPath := strings.TrimSpace(installerPath)
	if trimmedPath == "" {
		return fmt.Errorf("update installer path is required")
	}

	scriptPath := filepath.Join(filepath.Dir(trimmedPath), "apply-update.cmd")
	arguments := "/S"
	if autoLaunch {
		arguments += " /AUTOLAUNCH=1"
	}

	script := buildWindowsUpdateLauncherScript(trimmedPath, arguments)

	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		return fmt.Errorf("write update launcher: %w", err)
	}

	command := exec.Command("cmd", "/C", scriptPath)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := command.Start(); err != nil {
		return fmt.Errorf("launch update installer: %w", err)
	}
	return nil
}

func buildWindowsUpdateLauncherScript(installerPath string, arguments string) string {
	return strings.Join([]string{
		"@echo off",
		"setlocal",
		"for /l %%I in (1,1,60) do (",
		fmt.Sprintf("  tasklist /FI \"IMAGENAME eq %s\" | find /I \"%s\" >nul", windowsUpdateProcessImage, windowsUpdateProcessImage),
		"  if errorlevel 1 goto install",
		"  ping 127.0.0.1 -n 2 > nul",
		")",
		"del \"%~f0\"",
		"exit /b 32",
		":install",
		fmt.Sprintf("start \"\" /wait \"%s\" %s", installerPath, arguments),
		"del \"%~f0\"",
		"",
	}, "\r\n")
}
