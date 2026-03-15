//go:build !windows

package cloud

import "fmt"

func launchPreparedUpdate(installerPath string, autoLaunch bool) error {
	return fmt.Errorf("desktop self-update is not implemented on this platform")
}
