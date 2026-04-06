//go:build windows

package commandline

import (
	"context"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

func applyPlatformProcessAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW,
	}
}

func terminateManagedProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}

	taskkill := exec.CommandContext(
		context.Background(),
		"taskkill",
		"/T",
		"/F",
		"/PID",
		strconv.Itoa(cmd.Process.Pid),
	)
	taskkill.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW,
	}
	done := make(chan struct{})
	go func() {
		_ = taskkill.Run()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		if taskkill.Process != nil {
			_ = taskkill.Process.Kill()
		}
		<-done
	}
	_ = cmd.Process.Kill()
}
