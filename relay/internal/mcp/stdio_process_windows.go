//go:build windows

package mcp

import (
	"os/exec"
	"syscall"
)

func applyPlatformProcessAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: syscall.CREATE_NO_WINDOW,
	}
}
