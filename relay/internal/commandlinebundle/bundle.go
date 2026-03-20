package commandlinebundle

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
	Prepared              bool     `json:"prepared"`
	AssetVersion          string   `json:"assetVersion"`
	Platform              string   `json:"platform"`
	NodeBinary            string   `json:"nodeBinary"`
	NodeModulesDir        string   `json:"nodeModulesDir"`
	PythonHomeDir         string   `json:"pythonHomeDir"`
	PythonBinary          string   `json:"pythonBinary"`
	PythonSitePackagesDir string   `json:"pythonSitePackagesDir"`
	FFmpegBinary          string   `json:"ffmpegBinary"`
	FFprobeBinary         string   `json:"ffprobeBinary"`
	GitBinary             string   `json:"gitBinary"`
	BashBinary            string   `json:"bashBinary"`
	PackageProfile        string   `json:"packageProfile"`
	FFmpegReleaseTag      string   `json:"ffmpegReleaseTag"`
	Executables           []string `json:"executables"`
}

type Installation struct {
	RootDir               string
	NodeBinaryPath        string
	NodeModulesDir        string
	PythonHomeDir         string
	PythonBinaryPath      string
	PythonSitePackagesDir string
	FFmpegBinaryPath      string
	FFprobeBinaryPath     string
	GitBinaryPath         string
	BashBinaryPath        string
	PackageProfile        string
	FFmpegReleaseTag      string
	AssetVersion          string
}

func LoadManifest() (Manifest, error) {
	data, err := embeddedAssets.ReadFile("assets/manifest.json")
	if err != nil {
		return Manifest{}, fmt.Errorf("read commandline bundle manifest: %w", err)
	}

	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("parse commandline bundle manifest: %w", err)
	}
	return manifest, nil
}

func EnsureInstalled() (*Installation, error) {
	manifest, err := LoadManifest()
	if err != nil {
		return nil, err
	}
	if !manifest.Prepared {
		return nil, fmt.Errorf("bundled commandline runtime was not prepared for this build")
	}

	currentPlatform := runtime.GOOS + "-" + runtime.GOARCH
	if manifest.Platform != "" && manifest.Platform != currentPlatform {
		return nil, fmt.Errorf("bundled commandline runtime targets %s, but current platform is %s", manifest.Platform, currentPlatform)
	}

	rootDir := filepath.Join(config.DefaultDir(), "runtime", "commandline", manifest.AssetVersion)
	if err := ensureExtracted(rootDir, manifest); err != nil {
		return nil, err
	}

	return &Installation{
		RootDir:               rootDir,
		NodeBinaryPath:        joinIfNotEmpty(rootDir, manifest.NodeBinary),
		NodeModulesDir:        joinIfNotEmpty(rootDir, manifest.NodeModulesDir),
		PythonHomeDir:         joinIfNotEmpty(rootDir, manifest.PythonHomeDir),
		PythonBinaryPath:      joinIfNotEmpty(rootDir, manifest.PythonBinary),
		PythonSitePackagesDir: joinIfNotEmpty(rootDir, manifest.PythonSitePackagesDir),
		FFmpegBinaryPath:      joinIfNotEmpty(rootDir, manifest.FFmpegBinary),
		FFprobeBinaryPath:     joinIfNotEmpty(rootDir, manifest.FFprobeBinary),
		GitBinaryPath:         joinIfNotEmpty(rootDir, manifest.GitBinary),
		BashBinaryPath:        joinIfNotEmpty(rootDir, manifest.BashBinary),
		PackageProfile:        manifest.PackageProfile,
		FFmpegReleaseTag:      manifest.FFmpegReleaseTag,
		AssetVersion:          manifest.AssetVersion,
	}, nil
}

func ensureExtracted(rootDir string, manifest Manifest) error {
	readyMarker := filepath.Join(rootDir, ".ready")
	if data, err := os.ReadFile(readyMarker); err == nil && strings.TrimSpace(string(data)) == manifest.AssetVersion {
		markerTarget := joinIfNotEmpty(rootDir, manifest.NodeBinary)
		if markerTarget == "" {
			markerTarget = joinIfNotEmpty(rootDir, manifest.PythonBinary)
		}
		if markerTarget == "" || statExists(markerTarget) {
			return nil
		}
	}

	if err := os.RemoveAll(rootDir); err != nil {
		return fmt.Errorf("reset commandline runtime dir: %w", err)
	}
	if err := os.MkdirAll(rootDir, 0755); err != nil {
		return fmt.Errorf("create commandline runtime dir: %w", err)
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
		return fmt.Errorf("extract commandline runtime assets: %w", err)
	}

	if runtime.GOOS != "windows" {
		for _, executable := range manifest.Executables {
			targetPath := joinIfNotEmpty(rootDir, executable)
			if targetPath == "" || !statExists(targetPath) {
				continue
			}
			if err := os.Chmod(targetPath, 0755); err != nil {
				return fmt.Errorf("mark bundled executable %s: %w", executable, err)
			}
		}
	}

	if err := os.WriteFile(readyMarker, []byte(manifest.AssetVersion), 0644); err != nil {
		return fmt.Errorf("write commandline runtime marker: %w", err)
	}

	return nil
}

func joinIfNotEmpty(root, relative string) string {
	relative = strings.TrimSpace(relative)
	if relative == "" {
		return ""
	}
	return filepath.Join(root, filepath.FromSlash(relative))
}

func statExists(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}
