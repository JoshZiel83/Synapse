//go:build darwin

package desktopdiag

import (
	"fmt"
	"time"

	"golang.org/x/sys/unix"
)

func systemBootID() (string, error) {
	tv, err := unix.SysctlTimeval("kern.boottime")
	if err != nil {
		return "", err
	}
	bootTime := time.Unix(int64(tv.Sec), int64(tv.Usec)*1000).UTC()
	return fmt.Sprintf("boottime:%s", bootTime.Format(time.RFC3339Nano)), nil
}
