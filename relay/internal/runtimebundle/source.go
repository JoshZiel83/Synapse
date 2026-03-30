package runtimebundle

import (
	"fmt"
	"os"
	"path/filepath"
)

var executablePath = os.Executable

func ResolveRoot(userRoot string, verify func(string) bool, installedParts ...string) (string, bool) {
	if verify != nil {
		if installedRoot := InstalledRoot(installedParts...); installedRoot != "" && verify(installedRoot) {
			return installedRoot, true
		}
	}
	return userRoot, false
}

func InstalledRoot(parts ...string) string {
	path, err := executablePath()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}

	allParts := make([]string, 0, len(parts)+1)
	allParts = append(allParts, filepath.Dir(path))
	allParts = append(allParts, parts...)
	return filepath.Join(allParts...)
}

func ReadInstalledManifest(bundleName string) ([]byte, error) {
	manifestPath := InstalledRoot("runtime", bundleName, "manifest.json")
	if manifestPath == "" {
		return nil, fmt.Errorf("resolve installed manifest path for %s", bundleName)
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}
	return data, nil
}
