package nodebundle

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/runtimebundle"
)

type Manifest struct {
	Prepared     bool   `json:"prepared"`
	AssetVersion string `json:"assetVersion"`
	Platform     string `json:"platform"`
	NodeBinary   string `json:"nodeBinary"`
}

type Installation struct {
	RootDir        string
	NodeBinaryPath string
	AssetVersion   string
}

func LoadManifest() (Manifest, error) {
	data, err := loadManifestBytes()
	if err != nil {
		return Manifest{}, err
	}

	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("parse node bundle manifest: %w", err)
	}
	return manifest, nil
}

func EnsureInstalled() (*Installation, error) {
	manifest, err := LoadManifest()
	if err != nil {
		return nil, err
	}
	if !manifest.Prepared {
		return nil, fmt.Errorf("bundled shared node runtime was not prepared for this build")
	}

	currentPlatform := runtime.GOOS + "-" + runtime.GOARCH
	if manifest.Platform != "" && manifest.Platform != currentPlatform {
		return nil, fmt.Errorf("bundled shared node runtime targets %s, but current platform is %s", manifest.Platform, currentPlatform)
	}

	userRootDir := filepath.Join(config.DefaultDir(), "runtime", "node", manifest.AssetVersion)
	rootDir, installed := runtimebundle.ResolveRoot(userRootDir, func(dir string) bool {
		return installationReady(dir, manifest)
	}, "runtime", "node", manifest.AssetVersion)
	if !installed {
		if !runtimeExtractionSupported() {
			return nil, fmt.Errorf("shared node runtime is not installed alongside this application")
		}
		if err := ensureExtracted(rootDir, manifest); err != nil {
			return nil, err
		}
	}

	return &Installation{
		RootDir:        rootDir,
		NodeBinaryPath: filepath.Join(rootDir, filepath.FromSlash(manifest.NodeBinary)),
		AssetVersion:   manifest.AssetVersion,
	}, nil
}

func ensureExtracted(rootDir string, manifest Manifest) error {
	return runtimebundle.Ensure(runtimebundle.InstallOptions{
		RootDir: rootDir,
		Verify: func(dir string) bool {
			return installationReady(dir, manifest)
		},
		Install: func(stageDir string) error {
			if err := extractRuntimeAssets(stageDir); err != nil {
				return fmt.Errorf("extract shared node runtime assets: %w", err)
			}

			nodePath := filepath.Join(stageDir, filepath.FromSlash(manifest.NodeBinary))
			if runtime.GOOS != "windows" {
				if err := os.Chmod(nodePath, 0755); err != nil {
					return fmt.Errorf("mark bundled shared node executable: %w", err)
				}
			}

			readyMarker := filepath.Join(stageDir, ".ready")
			if err := os.WriteFile(readyMarker, []byte(manifest.AssetVersion), 0644); err != nil {
				return fmt.Errorf("write shared node runtime marker: %w", err)
			}

			return nil
		},
	})
}

func installationReady(rootDir string, manifest Manifest) bool {
	readyMarker := filepath.Join(rootDir, ".ready")
	if data, err := os.ReadFile(readyMarker); err == nil && strings.TrimSpace(string(data)) == manifest.AssetVersion {
		if _, err := os.Stat(filepath.Join(rootDir, filepath.FromSlash(manifest.NodeBinary))); err == nil {
			return true
		}
	}
	return false
}
