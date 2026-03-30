//go:build windows

package desktopdiag

import (
	"fmt"
	"syscall"
	"time"
)

var (
	kernel32Proc   = syscall.NewLazyDLL("kernel32.dll")
	getTickCount64 = kernel32Proc.NewProc("GetTickCount64")
)

func systemBootID() (string, error) {
	uptimeMillis, _, callErr := getTickCount64.Call()
	if uptimeMillis == 0 && callErr != syscall.Errno(0) {
		return "", callErr
	}

	bootTime := time.Now().UTC().Add(-time.Duration(uptimeMillis) * time.Millisecond)
	return fmt.Sprintf("boottime:%s", bootTime.Format(time.RFC3339Nano)), nil
}
