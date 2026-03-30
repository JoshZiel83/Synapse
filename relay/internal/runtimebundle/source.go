package runtimebundle

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var executablePath = os.Executable

func ResolveRoot(userRoot string, verify func(string) bool, packagedParts ...string) (string, bool) {
	if verify != nil {
		if packagedRoot := PackagedRoot(packagedParts...); packagedRoot != "" && verify(packagedRoot) {
			return packagedRoot, true
		}
	}
	return userRoot, false
}

func PackagedRoot(parts ...string) string {
	path, err := executablePath()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}

	baseDir := filepath.Dir(path)
	if strings.EqualFold(filepath.Base(baseDir), "MacOS") && strings.EqualFold(filepath.Base(filepath.Dir(baseDir)), "Contents") {
		baseDir = filepath.Join(filepath.Dir(baseDir), "Resources")
	}

	allParts := make([]string, 0, len(parts)+1)
	allParts = append(allParts, baseDir)
	allParts = append(allParts, parts...)
	return filepath.Join(allParts...)
}

func ReadPackagedManifest(bundleName string) ([]byte, error) {
	manifestPath := PackagedRoot("runtime", bundleName, "manifest.json")
	if manifestPath == "" {
		return nil, fmt.Errorf("resolve packaged manifest path for %s", bundleName)
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}
	return data, nil
}
