package runtimebundle

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var executablePath = os.Executable
var lookupEnv = os.LookupEnv

const packagedRootEnv = "SYNAPSE_RELAY_PACKAGED_ROOT"

func ResolveRoot(userRoot string, verify func(string) bool, packagedParts ...string) (string, bool) {
	if verify != nil {
		if packagedRoot := PackagedRoot(packagedParts...); packagedRoot != "" && verify(packagedRoot) {
			return packagedRoot, true
		}
	}
	return userRoot, false
}

func PackagedRoot(parts ...string) string {
	baseDir := packagedBaseDir()
	if baseDir == "" {
		return ""
	}

	allParts := make([]string, 0, len(parts)+1)
	allParts = append(allParts, baseDir)
	allParts = append(allParts, parts...)
	return filepath.Join(allParts...)
}

func packagedBaseDir() string {
	if override, ok := lookupEnv(packagedRootEnv); ok {
		override = strings.TrimSpace(override)
		if override != "" {
			if resolved, err := filepath.EvalSymlinks(override); err == nil {
				override = resolved
			}
			return filepath.Clean(override)
		}
	}

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
	return baseDir
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
