//go:build windows

package commandline

import (
	"os"
	"os/exec"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestHelperManagedProcessSleep(t *testing.T) {
	if os.Getenv("GO_WANT_COMMANDLINE_HELPER_SLEEP") != "1" {
		return
	}
	time.Sleep(30 * time.Second)
	os.Exit(0)
}

func TestBindManagedProcessFallsBackBeforeWindows8(t *testing.T) {
	restore := windowsVersionProvider
	windowsVersionProvider = func() *windows.OsVersionInfoEx {
		return &windows.OsVersionInfoEx{MajorVersion: 6, MinorVersion: 1}
	}
	defer func() {
		windowsVersionProvider = restore
	}()

	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperManagedProcessSleep$")
	cmd.Env = append(os.Environ(), "GO_WANT_COMMANDLINE_HELPER_SLEEP=1")
	applyPlatformProcessAttrs(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}
	defer func() {
		terminateManagedProcess(cmd, managedProcessController{})
		_, _ = cmd.Process.Wait()
	}()

	controller, err := bindManagedProcess(cmd)
	if err != nil {
		t.Fatalf("expected fallback without error, got %v", err)
	}
	if got := processControlMode(controller); got != processControlModeWindowsTaskkillTree {
		t.Fatalf("expected fallback mode %q, got %q", processControlModeWindowsTaskkillTree, got)
	}
}

func TestReleaseManagedProcessKillsJobProcess(t *testing.T) {
	restore := windowsVersionProvider
	windowsVersionProvider = func() *windows.OsVersionInfoEx {
		return &windows.OsVersionInfoEx{MajorVersion: 10, MinorVersion: 0}
	}
	defer func() {
		windowsVersionProvider = restore
	}()

	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperManagedProcessSleep$")
	cmd.Env = append(os.Environ(), "GO_WANT_COMMANDLINE_HELPER_SLEEP=1")
	applyPlatformProcessAttrs(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}

	controller, err := bindManagedProcess(cmd)
	if err != nil {
		terminateManagedProcess(cmd, controller)
		_, _ = cmd.Process.Wait()
		t.Fatalf("bind managed process: %v", err)
	}
	if got := processControlMode(controller); got != processControlModeWindowsJobObject {
		terminateManagedProcess(cmd, controller)
		_, _ = cmd.Process.Wait()
		t.Fatalf("expected job object mode %q, got %q", processControlModeWindowsJobObject, got)
	}

	releaseManagedProcess(controller)

	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		terminateManagedProcess(cmd, managedProcessController{})
		t.Fatal("expected helper process to exit after closing job handle")
	}
}
