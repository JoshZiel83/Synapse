package commandlinebundle

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/PekingSpades/Synapse/relay/internal/nodebundle"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
	"github.com/PekingSpades/Synapse/relay/internal/runtimebundle"
)

type Manifest struct {
	Prepared              bool                `json:"prepared"`
	AssetVersion          string              `json:"assetVersion"`
	Platform              string              `json:"platform"`
	NodeAssetVersion      string              `json:"nodeAssetVersion"`
	NodeModulesDir        string              `json:"nodeModulesDir"`
	PythonHomeDir         string              `json:"pythonHomeDir"`
	PythonBinary          string              `json:"pythonBinary"`
	PythonSitePackagesDir string              `json:"pythonSitePackagesDir"`
	ManagedBinDir         string              `json:"managedBinDir"`
	FFmpegBinary          string              `json:"ffmpegBinary"`
	FFprobeBinary         string              `json:"ffprobeBinary"`
	GitBinary             string              `json:"gitBinary"`
	BashBinary            string              `json:"bashBinary"`
	ManagedProviders      []ManagedProvider   `json:"managedProviders"`
	ManagedCapabilities   []ManagedCapability `json:"managedCapabilities"`
	PackageProfile        string              `json:"packageProfile"`
	FFmpegReleaseTag      string              `json:"ffmpegReleaseTag"`
	Executables           []string            `json:"executables"`
}

const packagedBundleDir = "cl"

type ManagedCapabilityProbe struct {
	Type       string   `json:"type"`
	EnvPathVar string   `json:"envPathVar"`
	Candidates []string `json:"candidates"`
	Paths      []string `json:"paths"`
}

type ManagedProvider struct {
	Slug        string `json:"slug"`
	DisplayName string `json:"displayName"`
	RuntimeType string `json:"runtimeType"`
	Version     string `json:"version"`
}

type ManagedCapability struct {
	Provider            string                 `json:"provider"`
	ProviderDisplayName string                 `json:"providerDisplayName"`
	Slug                string                 `json:"slug"`
	Command             string                 `json:"command"`
	Module              string                 `json:"module,omitempty"`
	Version             string                 `json:"version"`
	UnavailableReason   string                 `json:"unavailableReason,omitempty"`
	Probe               ManagedCapabilityProbe `json:"probe"`
}

type Installation struct {
	RootDir               string
	NodeBinaryPath        string
	NodeModulesDir        string
	PythonHomeDir         string
	PythonBinaryPath      string
	PythonSitePackagesDir string
	ManagedBinDir         string
	FFmpegBinaryPath      string
	FFprobeBinaryPath     string
	GitBinaryPath         string
	BashBinaryPath        string
	ManagedProviders      []ManagedProvider
	ManagedCapabilities   []ManagedCapability
	PackageProfile        string
	FFmpegReleaseTag      string
	AssetVersion          string
}

func LoadManifest() (Manifest, error) {
	data, err := loadManifestBytes()
	if err != nil {
		return Manifest{}, err
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

	nodeInstallation, nodeErr := nodebundle.EnsureInstalled()
	userRootDir := filepath.Join(relaypaths.Current().SharedRuntimeRoot, packagedBundleDir, manifest.AssetVersion)
	rootDir, installed := runtimebundle.ResolveRoot(userRootDir, func(dir string) bool {
		return installationReady(dir, manifest)
	}, "runtime", packagedBundleDir, manifest.AssetVersion)
	rootErr := error(nil)
	if !installed {
		if !runtimeExtractionSupported() {
			return nil, fmt.Errorf("commandline runtime is not installed alongside this application")
		}
		rootErr = ensureExtracted(rootDir, manifest)
	}
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
		return nil, fmt.Errorf("shared node runtime version mismatch: commandline bundle expects %s, got %s", manifest.NodeAssetVersion, nodeInstallation.AssetVersion)
	}

	return &Installation{
		RootDir:               rootDir,
		NodeBinaryPath:        nodeInstallation.NodeBinaryPath,
		NodeModulesDir:        joinIfNotEmpty(rootDir, manifest.NodeModulesDir),
		PythonHomeDir:         joinIfNotEmpty(rootDir, manifest.PythonHomeDir),
		PythonBinaryPath:      joinIfNotEmpty(rootDir, manifest.PythonBinary),
		PythonSitePackagesDir: joinIfNotEmpty(rootDir, manifest.PythonSitePackagesDir),
		ManagedBinDir:         joinIfNotEmpty(rootDir, manifest.ManagedBinDir),
		FFmpegBinaryPath:      joinIfNotEmpty(rootDir, manifest.FFmpegBinary),
		FFprobeBinaryPath:     joinIfNotEmpty(rootDir, manifest.FFprobeBinary),
		GitBinaryPath:         joinIfNotEmpty(rootDir, manifest.GitBinary),
		BashBinaryPath:        joinIfNotEmpty(rootDir, manifest.BashBinary),
		ManagedProviders:      manifest.ManagedProviders,
		ManagedCapabilities:   manifest.ManagedCapabilities,
		PackageProfile:        manifest.PackageProfile,
		FFmpegReleaseTag:      manifest.FFmpegReleaseTag,
		AssetVersion:          manifest.AssetVersion,
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
				return fmt.Errorf("extract commandline runtime assets: %w", err)
			}

			if runtime.GOOS != "windows" {
				for _, executable := range manifest.Executables {
					targetPath := joinIfNotEmpty(stageDir, executable)
					if targetPath == "" || !statExists(targetPath) {
						continue
					}
					if err := os.Chmod(targetPath, 0755); err != nil {
						return fmt.Errorf("mark bundled executable %s: %w", executable, err)
					}
				}
			}

			readyMarker := filepath.Join(stageDir, ".ready")
			if err := os.WriteFile(readyMarker, []byte(manifest.AssetVersion), 0644); err != nil {
				return fmt.Errorf("write commandline runtime marker: %w", err)
			}

			return nil
		},
	})
}

func installationReady(rootDir string, manifest Manifest) bool {
	readyMarker := filepath.Join(rootDir, ".ready")
	if data, err := os.ReadFile(readyMarker); err == nil && strings.TrimSpace(string(data)) == manifest.AssetVersion {
		markerTarget := firstNonEmpty(
			joinIfNotEmpty(rootDir, manifest.PythonBinary),
			joinIfNotEmpty(rootDir, manifest.FFmpegBinary),
			joinIfNotEmpty(rootDir, manifest.FFprobeBinary),
			joinIfNotEmpty(rootDir, manifest.NodeModulesDir),
			joinIfNotEmpty(rootDir, manifest.GitBinary),
			joinIfNotEmpty(rootDir, manifest.BashBinary),
		)
		if markerTarget == "" || statExists(markerTarget) {
			return true
		}
	}
	return false
}

func joinIfNotEmpty(root, relative string) string {
	relative = strings.TrimSpace(relative)
	if relative == "" {
		return ""
	}
	return filepath.Join(root, filepath.FromSlash(relative))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func statExists(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}
