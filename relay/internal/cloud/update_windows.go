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

	script := strings.Join([]string{
		"@echo off",
		"ping 127.0.0.1 -n 3 > nul",
		fmt.Sprintf("start \"\" /wait \"%s\" %s", trimmedPath, arguments),
		"del \"%~f0\"",
		"",
	}, "\r\n")

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
