//go:build windows

package filesystem

import (
	"os"
	"path/filepath"
	"strings"
)

func globalRootPaths() []string {
	var roots []string
	for drive := 'A'; drive <= 'Z'; drive++ {
		root := string(drive) + `:\`
		if _, err := os.Stat(root); err == nil {
			roots = append(roots, root)
		}
	}
	return roots
}

func blockedSystemPaths() []string {
	paths := []string{
		os.Getenv("WINDIR"),
		os.Getenv("ProgramFiles"),
		os.Getenv("ProgramFiles(x86)"),
		os.Getenv("ProgramData"),
	}
	var prefixes []string
	for _, path := range paths {
		if strings.TrimSpace(path) == "" {
			continue
		}
		prefixes = append(prefixes, path)
	}
	for _, root := range globalRootPaths() {
		prefixes = append(prefixes,
			filepath.Join(root, "Windows"),
			filepath.Join(root, "Program Files"),
			filepath.Join(root, "Program Files (x86)"),
			filepath.Join(root, "ProgramData"),
			filepath.Join(root, "System Volume Information"),
			filepath.Join(root, "$Recycle.Bin"),
		)
	}
	return prefixes
}

func normalizePathForMatch(path string) string {
	return strings.ToLower(filepath.Clean(path))
}

func pathWithinPrefix(path, prefix string) bool {
	path = normalizePathForMatch(path)
	prefix = normalizePathForMatch(prefix)
	if path == prefix {
		return true
	}
	return strings.HasPrefix(path, prefix+`\`)
}
