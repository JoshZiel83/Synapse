//go:build !windows

package mcp

import "os/exec"

func applyPlatformProcessAttrs(cmd *exec.Cmd) {
	_ = cmd
}
