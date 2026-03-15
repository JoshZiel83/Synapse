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
)

//go:embed all:assets
var embeddedAssets embed.FS

type Manifest struct {
	Prepared       bool   `json:"prepared"`
	AssetVersion   string `json:"assetVersion"`
	Platform       string `json:"platform"`
	NodeBinary     string `json:"nodeBinary"`
	PackageDir     string `json:"packageDir"`
	EntryScript    string `json:"entryScript"`
	PackageVersion string `json:"packageVersion"`
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

	rootDir := filepath.Join(config.DefaultDir(), "runtime", "chrome-devtools-mcp", manifest.AssetVersion)
	if err := ensureExtracted(rootDir, manifest); err != nil {
		return nil, err
	}

	return &Installation{
		RootDir:        rootDir,
		NodeBinaryPath: filepath.Join(rootDir, filepath.FromSlash(manifest.NodeBinary)),
		PackageDir:     filepath.Join(rootDir, filepath.FromSlash(manifest.PackageDir)),
		EntryScript:    filepath.Join(rootDir, filepath.FromSlash(manifest.EntryScript)),
		PackageVersion: manifest.PackageVersion,
		AssetVersion:   manifest.AssetVersion,
	}, nil
}

func ensureExtracted(rootDir string, manifest Manifest) error {
	readyMarker := filepath.Join(rootDir, ".ready")
	if data, err := os.ReadFile(readyMarker); err == nil && strings.TrimSpace(string(data)) == manifest.AssetVersion {
		if _, err := os.Stat(filepath.Join(rootDir, filepath.FromSlash(manifest.EntryScript))); err == nil {
			return nil
		}
	}

	if err := os.RemoveAll(rootDir); err != nil {
		return fmt.Errorf("reset chrome-devtools runtime dir: %w", err)
	}
	if err := os.MkdirAll(rootDir, 0755); err != nil {
		return fmt.Errorf("create chrome-devtools runtime dir: %w", err)
	}

	if err := fs.WalkDir(embeddedAssets, "assets", func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == "assets" {
			return nil
		}

		relativePath := strings.TrimPrefix(path, "assets/")
		targetPath := filepath.Join(rootDir, filepath.FromSlash(relativePath))
		if d.IsDir() {
			return os.MkdirAll(targetPath, 0755)
		}

		data, err := embeddedAssets.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return err
		}
		return os.WriteFile(targetPath, data, 0644)
	}); err != nil {
		return fmt.Errorf("extract chrome-devtools runtime assets: %w", err)
	}

	nodePath := filepath.Join(rootDir, filepath.FromSlash(manifest.NodeBinary))
	if runtime.GOOS != "windows" {
		if err := os.Chmod(nodePath, 0755); err != nil {
			return fmt.Errorf("mark bundled node executable: %w", err)
		}
	}

	if err := os.WriteFile(readyMarker, []byte(manifest.AssetVersion), 0644); err != nil {
		return fmt.Errorf("write chrome-devtools runtime marker: %w", err)
	}

	return nil
}
