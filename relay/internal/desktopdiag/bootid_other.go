//go:build !linux && !darwin && !windows

package desktopdiag

import "fmt"

func systemBootID() (string, error) {
	return "", fmt.Errorf("boot id not supported on this platform")
}
