package cloud

import (
	"fmt"
	"os"
	"runtime"
	"strings"
)

func ResolveRelayDisplayName(displayName string) string {
	trimmed := strings.TrimSpace(displayName)
	if trimmed != "" {
		return trimmed
	}
	return DefaultRelayDisplayName()
}

func DefaultRelayDisplayName() string {
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		host = "unknown-host"
	}
	host = strings.Join(strings.Fields(strings.TrimSpace(host)), "-")
	if host == "" {
		host = "unknown-host"
	}
	return fmt.Sprintf("%s@%s", platformTitlePrefix(runtime.GOOS), host)
}

func platformTitlePrefix(goos string) string {
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "windows":
		return "windows"
	case "darwin":
		return "macos"
	case "linux":
		return "linux"
	default:
		if strings.TrimSpace(goos) == "" {
			return "device"
		}
		return strings.ToLower(strings.TrimSpace(goos))
	}
}

func platformDisplayName(goos string) string {
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "windows":
		return "Windows"
	case "darwin":
		return "macOS"
	case "linux":
		return "Linux"
	default:
		if goos == "" {
			return "Device"
		}
		return strings.ToUpper(goos[:1]) + goos[1:]
	}
}
