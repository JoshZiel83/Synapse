//go:build !windows

package filesystem

import (
	"path/filepath"
	"runtime"
	"strings"
)

func globalRootPaths() []string {
	return []string{"/"}
}

func blockedSystemPaths() []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{"/System", "/Library", "/private/var", "/private/System", "/dev"}
	default:
		return []string{"/proc", "/sys", "/dev", "/run", "/var/run", "/boot"}
	}
}

func normalizePathForMatch(path string) string {
	return filepath.Clean(path)
}

func pathWithinPrefix(path, prefix string) bool {
	path = normalizePathForMatch(path)
	prefix = normalizePathForMatch(prefix)
	if path == prefix {
		return true
	}
	if prefix == "/" {
		return strings.HasPrefix(path, "/")
	}
	return strings.HasPrefix(path, prefix+"/")
}
