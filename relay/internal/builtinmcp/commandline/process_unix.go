//go:build !windows

package commandline

import (
	"os/exec"
	"syscall"
)

type managedProcessController struct{}

func applyPlatformProcessAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
	}
}

func bindManagedProcess(_ *exec.Cmd) (managedProcessController, error) {
	return managedProcessController{}, nil
}

func releaseManagedProcess(_ managedProcessController) {}

func processControlMode(_ managedProcessController) string {
	return "process_group"
}

func terminateManagedProcess(cmd *exec.Cmd, _ managedProcessController) {
	if cmd == nil || cmd.Process == nil {
		return
	}

	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err == nil && pgid > 0 {
		_ = syscall.Kill(-pgid, syscall.SIGTERM)
		return
	}

	_ = cmd.Process.Kill()
}
