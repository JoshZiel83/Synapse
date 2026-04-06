//go:build darwin

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

	executablePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve current executable: %w", err)
	}

	scriptPath := filepath.Join(filepath.Dir(trimmedPath), "apply-update.sh")
	script := buildDarwinUpdateLauncherScript(trimmedPath, executablePath, autoLaunch)

	if err := os.WriteFile(scriptPath, []byte(script), 0o700); err != nil {
		return fmt.Errorf("write update launcher: %w", err)
	}

	command := exec.Command("/bin/bash", scriptPath)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		return fmt.Errorf("launch update installer: %w", err)
	}
	return nil
}
