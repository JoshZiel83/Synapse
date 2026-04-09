//go:build windows

package commandline

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	processControlModeWindowsTaskkillTree = "windows_taskkill_tree"
	processControlModeWindowsJobObject    = "windows_job_object"
)

type managedProcessController struct {
	job  windows.Handle
	mode string
}

var windowsVersionProvider = func() *windows.OsVersionInfoEx {
	return windows.RtlGetVersion()
}

func applyPlatformProcessAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW,
	}
}

func supportsJobObjectProcessControl() bool {
	version := windowsVersionProvider()
	if version == nil {
		return false
	}
	return version.MajorVersion > 6 || (version.MajorVersion == 6 && version.MinorVersion >= 2)
}

func bindManagedProcess(cmd *exec.Cmd) (managedProcessController, error) {
	controller := managedProcessController{mode: processControlModeWindowsTaskkillTree}
	if cmd == nil || cmd.Process == nil {
		return controller, fmt.Errorf("process was not started")
	}
	if !supportsJobObjectProcessControl() {
		return controller, nil
	}

	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return controller, fmt.Errorf("create job object: %w", err)
	}

	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return controller, fmt.Errorf("configure job object: %w", err)
	}

	processHandle, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(cmd.Process.Pid),
	)
	if err != nil {
		_ = windows.CloseHandle(job)
		return controller, fmt.Errorf("open process for job assignment: %w", err)
	}
	defer windows.CloseHandle(processHandle)

	if err := windows.AssignProcessToJobObject(job, processHandle); err != nil {
		_ = windows.CloseHandle(job)
		return controller, fmt.Errorf("assign process to job object: %w", err)
	}

	controller.job = job
	controller.mode = processControlModeWindowsJobObject
	return controller, nil
}

func releaseManagedProcess(controller managedProcessController) {
	if controller.job != 0 {
		_ = windows.CloseHandle(controller.job)
	}
}

func processControlMode(controller managedProcessController) string {
	if controller.mode != "" {
		return controller.mode
	}
	return processControlModeWindowsTaskkillTree
}

func terminateManagedProcess(cmd *exec.Cmd, controller managedProcessController) {
	if controller.job != 0 {
		if err := windows.TerminateJobObject(controller.job, 1); err == nil {
			return
		}
	}

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
