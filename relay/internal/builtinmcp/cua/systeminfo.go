package cua

import (
	"runtime"
	"strings"
)

func detectSystemDescription() string {
	description := strings.TrimSpace(platformSystemDescription())
	if description != "" {
		return description
	}

	switch runtime.GOOS {
	case "darwin":
		return "macOS"
	case "windows":
		return "Windows"
	case "linux":
		return "Linux"
	default:
		return runtime.GOOS
	}
}
