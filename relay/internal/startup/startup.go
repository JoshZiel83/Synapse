package startup

import "runtime"

const appName = "Synapse Relay"
const LaunchAtLoginFlag = "--launched-at-login"

func IsSupported() bool {
	switch runtime.GOOS {
	case "windows", "darwin", "linux":
		return true
	default:
		return false
	}
}
