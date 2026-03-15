//go:build !windows

package chrome

import "os/exec"

func applyPlatformProcessAttrs(cmd *exec.Cmd) {
	_ = cmd
}
