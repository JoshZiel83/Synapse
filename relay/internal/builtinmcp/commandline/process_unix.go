//go:build !windows

package commandline

import "os/exec"

func applyPlatformProcessAttrs(cmd *exec.Cmd) {
	_ = cmd
}
