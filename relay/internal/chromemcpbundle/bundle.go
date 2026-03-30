package chromemcpbundle

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/nodebundle"
	"github.com/PekingSpades/Synapse/relay/internal/runtimebundle"
)

//go:embed all:assets
var embeddedAssets embed.FS

type Manifest struct {
	Prepared         bool   `json:"prepared"`
	AssetVersion     string `json:"assetVersion"`
	Platform         string `json:"platform"`
	NodeAssetVersion string `json:"nodeAssetVersion"`
	PackageDir       string `json:"packageDir"`
	EntryScript      string `json:"entryScript"`
	PackageVersion   string `json:"packageVersion"`
}

type Installation struct {
	RootDir        string
	NodeBinaryPath string
	PackageDir     string
	EntryScript    string
	PackageVersion string
	AssetVersion   string
}

func LoadManifest() (Manifest, error) {
	data, err := embeddedAssets.ReadFile("assets/manifest.json")
	if err != nil {
		return Manifest{}, fmt.Errorf("read chrome-devtools bundle manifest: %w", err)
	}

	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("parse chrome-devtools bundle manifest: %w", err)
	}
	return manifest, nil
}

func EnsureInstalled() (*Installation, error) {
	manifest, err := LoadManifest()
	if err != nil {
		return nil, err
	}
	if !manifest.Prepared {
		return nil, fmt.Errorf("bundled chrome-devtools runtime was not prepared for this build")
	}

	currentPlatform := runtime.GOOS + "-" + runtime.GOARCH
	if manifest.Platform != "" && manifest.Platform != currentPlatform {
		return nil, fmt.Errorf("bundled chrome-devtools runtime targets %s, but current platform is %s", manifest.Platform, currentPlatform)
	}

	nodeInstallation, nodeErr := nodebundle.EnsureInstalled()
	rootDir := filepath.Join(config.DefaultDir(), "runtime", "chrome-devtools-mcp", manifest.AssetVersion)
	rootErr := ensureExtracted(rootDir, manifest)
	if nodeErr != nil && !runtimebundle.IsPending(nodeErr) {
		return nil, nodeErr
	}
	if rootErr != nil && !runtimebundle.IsPending(rootErr) {
		return nil, rootErr
	}
	if nodeErr != nil {
		return nil, nodeErr
	}
	if rootErr != nil {
		return nil, rootErr
	}
	if manifest.NodeAssetVersion != "" && nodeInstallation.AssetVersion != manifest.NodeAssetVersion {
		return nil, fmt.Errorf("shared node runtime version mismatch: chrome bundle expects %s, got %s", manifest.NodeAssetVersion, nodeInstallation.AssetVersion)
	}

	return &Installation{
		RootDir:        rootDir,
		NodeBinaryPath: nodeInstallation.NodeBinaryPath,
		PackageDir:     filepath.Join(rootDir, filepath.FromSlash(manifest.PackageDir)),
		EntryScript:    filepath.Join(rootDir, filepath.FromSlash(manifest.EntryScript)),
		PackageVersion: manifest.PackageVersion,
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
			if err := fs.WalkDir(embeddedAssets, "assets", func(path string, d fs.DirEntry, walkErr error) error {
				if walkErr != nil {
					return walkErr
				}
				if path == "assets" {
					return nil
				}

				relativePath := strings.TrimPrefix(path, "assets/")
				targetPath := filepath.Join(stageDir, filepath.FromSlash(relativePath))
				if d.IsDir() {
					return os.MkdirAll(targetPath, 0755)
				}

				data, err := embeddedAssets.ReadFile(path)
				if err != nil {
					return err
				}
				return runtimebundle.WriteFile(targetPath, data, 0644)
			}); err != nil {
				return fmt.Errorf("extract chrome-devtools runtime assets: %w", err)
			}

			readyMarker := filepath.Join(stageDir, ".ready")
			if err := os.WriteFile(readyMarker, []byte(manifest.AssetVersion), 0644); err != nil {
				return fmt.Errorf("write chrome-devtools runtime marker: %w", err)
			}
			return nil
		},
	})
}

func installationReady(rootDir string, manifest Manifest) bool {
	readyMarker := filepath.Join(rootDir, ".ready")
	if data, err := os.ReadFile(readyMarker); err == nil && strings.TrimSpace(string(data)) == manifest.AssetVersion {
		if _, err := os.Stat(filepath.Join(rootDir, filepath.FromSlash(manifest.EntryScript))); err == nil {
			return true
		}
	}
	return false
}
