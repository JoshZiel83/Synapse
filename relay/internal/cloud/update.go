package cloud

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/config"
)

type DesktopUpdateManifest struct {
	Channel     string `json:"channel"`
	Platform    string `json:"platform"`
	Arch        string `json:"arch"`
	Version     string `json:"version"`
	DownloadURL string `json:"downloadUrl"`
	SHA256      string `json:"sha256,omitempty"`
	Notes       string `json:"notes,omitempty"`
	PublishedAt string `json:"publishedAt,omitempty"`
}

type DesktopUpdateResult struct {
	CheckedAt    string                 `json:"checkedAt"`
	Manifest     *DesktopUpdateManifest `json:"manifest,omitempty"`
	Available    bool                   `json:"available"`
	Downloaded   bool                   `json:"downloaded"`
	DownloadPath string                 `json:"downloadPath,omitempty"`
}

type semanticVersion struct {
	major      int
	minor      int
	patch      int
	prerelease string
}

func CheckForDesktopUpdate(ctx context.Context, relayCfg config.RelayConfig, updateCfg config.UpdateConfig, currentVersion string) (*DesktopUpdateResult, error) {
	result := &DesktopUpdateResult{
		CheckedAt: time.Now().UTC().Format(time.RFC3339),
	}

	serverBaseURL := config.NormalizeServerBaseURL(relayCfg.ServerBaseURL)
	if serverBaseURL == "" {
		return result, nil
	}

	manifest, err := fetchDesktopUpdateManifest(ctx, relayCfg, updateCfg.Channel)
	if err != nil {
		return nil, err
	}
	if manifest == nil {
		return result, nil
	}

	result.Manifest = manifest
	result.Available = versionIsNewer(currentVersion, manifest.Version)
	if !result.Available {
		return result, nil
	}

	if strings.EqualFold(strings.TrimSpace(updateCfg.PendingVersion), strings.TrimSpace(manifest.Version)) {
		pendingPath := strings.TrimSpace(updateCfg.PendingInstaller)
		if pendingPath != "" {
			if info, statErr := os.Stat(pendingPath); statErr == nil && !info.IsDir() {
				result.Downloaded = true
				result.DownloadPath = pendingPath
				return result, nil
			}
		}
	}

	downloadPath, err := downloadDesktopUpdate(ctx, relayCfg, manifest)
	if err != nil {
		return nil, err
	}

	result.Downloaded = true
	result.DownloadPath = downloadPath
	return result, nil
}

func LaunchPreparedUpdate(installerPath string, autoLaunch bool) error {
	return launchPreparedUpdate(installerPath, autoLaunch)
}

func fetchDesktopUpdateManifest(ctx context.Context, relayCfg config.RelayConfig, channel string) (*DesktopUpdateManifest, error) {
	serverBaseURL := config.NormalizeServerBaseURL(relayCfg.ServerBaseURL)
	if serverBaseURL == "" {
		return nil, nil
	}

	requestURL, err := url.Parse(serverBaseURL + "/api/v1/mcp/relay/updates/latest")
	if err != nil {
		return nil, fmt.Errorf("build update URL: %w", err)
	}
	query := requestURL.Query()
	query.Set("channel", normalizeUpdateChannel(channel))
	query.Set("platform", runtime.GOOS)
	query.Set("arch", runtime.GOARCH)
	requestURL.RawQuery = query.Encode()

	client, err := newPinnedHTTPClient(relayCfg, requestURL.String())
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("create update request: %w", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("check updates: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode >= http.StatusBadRequest {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("check updates failed with status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var manifest DesktopUpdateManifest
	if err := json.NewDecoder(resp.Body).Decode(&manifest); err != nil {
		return nil, fmt.Errorf("decode update response: %w", err)
	}

	manifest.Channel = normalizeUpdateChannel(manifest.Channel)
	manifest.Version = strings.TrimSpace(manifest.Version)
	manifest.DownloadURL = strings.TrimSpace(manifest.DownloadURL)
	if manifest.Version == "" || manifest.DownloadURL == "" {
		return nil, fmt.Errorf("update manifest is incomplete")
	}
	if err := validateManifestDownloadURL(serverBaseURL, manifest.DownloadURL); err != nil {
		return nil, err
	}
	return &manifest, nil
}

func newPinnedHTTPClient(relayCfg config.RelayConfig, rawURL string) (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	tlsConfig, err := buildPinnedTLSConfig(rawURL, relayCfg.ServerTLSPublicKeyPin, nil)
	if err != nil {
		return nil, err
	}
	if tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}
	return &http.Client{
		Timeout:   60 * time.Second,
		Transport: transport,
	}, nil
}

func downloadDesktopUpdate(ctx context.Context, relayCfg config.RelayConfig, manifest *DesktopUpdateManifest) (string, error) {
	if manifest == nil {
		return "", fmt.Errorf("update manifest is required")
	}

	client, err := newPinnedHTTPClient(relayCfg, manifest.DownloadURL)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, manifest.DownloadURL, nil)
	if err != nil {
		return "", fmt.Errorf("create update download request: %w", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("download update: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusBadRequest {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("download update failed with status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	if err := config.EnsureDir(); err != nil {
		return "", err
	}

	targetDir := filepath.Join(config.DefaultDir(), "updates", manifest.Version)
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return "", fmt.Errorf("create update directory: %w", err)
	}

	filename := updateFilename(manifest.DownloadURL)
	finalPath := filepath.Join(targetDir, filename)
	tempPath := finalPath + ".download"

	file, err := os.Create(tempPath)
	if err != nil {
		return "", fmt.Errorf("create update file: %w", err)
	}

	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(file, hasher), resp.Body); err != nil {
		_ = file.Close()
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("write update file: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("close update file: %w", err)
	}

	expectedHash := normalizeSHA256(manifest.SHA256)
	if expectedHash != "" {
		actualHash := hex.EncodeToString(hasher.Sum(nil))
		if !strings.EqualFold(expectedHash, actualHash) {
			_ = os.Remove(tempPath)
			return "", fmt.Errorf("downloaded update checksum mismatch")
		}
	}

	if err := os.Rename(tempPath, finalPath); err != nil {
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("finalize update file: %w", err)
	}
	return finalPath, nil
}

func normalizeUpdateChannel(channel string) string {
	trimmed := strings.TrimSpace(strings.ToLower(channel))
	if trimmed == "" {
		return "stable"
	}
	return trimmed
}

func validateManifestDownloadURL(serverBaseURL, rawDownloadURL string) error {
	serverURL, err := url.Parse(serverBaseURL)
	if err != nil {
		return fmt.Errorf("invalid relay server URL: %w", err)
	}
	downloadURL, err := url.Parse(rawDownloadURL)
	if err != nil {
		return fmt.Errorf("invalid update download URL: %w", err)
	}
	if !strings.EqualFold(serverURL.Scheme, downloadURL.Scheme) || !strings.EqualFold(serverURL.Host, downloadURL.Host) {
		return fmt.Errorf("update download URL must use the paired relay server origin")
	}
	return nil
}

func updateFilename(rawDownloadURL string) string {
	parsed, err := url.Parse(rawDownloadURL)
	if err == nil {
		name := path.Base(parsed.Path)
		if strings.TrimSpace(name) != "" && name != "." && name != "/" {
			return name
		}
	}
	return fmt.Sprintf("synapse-relay-%s-%s-%s.exe", runtime.GOOS, runtime.GOARCH, strconv.FormatInt(time.Now().Unix(), 10))
}

func normalizeSHA256(value string) string {
	trimmed := strings.TrimSpace(strings.ToLower(value))
	trimmed = strings.TrimPrefix(trimmed, "sha256:")
	return trimmed
}

func versionIsNewer(currentVersion, nextVersion string) bool {
	comparison, ok := compareSemanticVersions(currentVersion, nextVersion)
	return ok && comparison < 0
}

func compareSemanticVersions(left, right string) (int, bool) {
	leftVersion, leftOK := parseSemanticVersion(left)
	rightVersion, rightOK := parseSemanticVersion(right)
	if !leftOK || !rightOK {
		trimmedLeft := strings.TrimSpace(left)
		trimmedRight := strings.TrimSpace(right)
		if trimmedLeft != "" && trimmedLeft == trimmedRight {
			return 0, true
		}
		return 0, false
	}

	if leftVersion.major != rightVersion.major {
		return compareInt(leftVersion.major, rightVersion.major), true
	}
	if leftVersion.minor != rightVersion.minor {
		return compareInt(leftVersion.minor, rightVersion.minor), true
	}
	if leftVersion.patch != rightVersion.patch {
		return compareInt(leftVersion.patch, rightVersion.patch), true
	}
	if leftVersion.prerelease == rightVersion.prerelease {
		return 0, true
	}
	if leftVersion.prerelease == "" {
		return 1, true
	}
	if rightVersion.prerelease == "" {
		return -1, true
	}
	return strings.Compare(leftVersion.prerelease, rightVersion.prerelease), true
}

func parseSemanticVersion(raw string) (semanticVersion, bool) {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.TrimPrefix(trimmed, "v")
	if trimmed == "" {
		return semanticVersion{}, false
	}

	trimmed = strings.Split(trimmed, "+")[0]
	parts := strings.SplitN(trimmed, "-", 2)
	core := parts[0]
	prerelease := ""
	if len(parts) == 2 {
		prerelease = parts[1]
	}

	numbers := strings.Split(core, ".")
	if len(numbers) != 3 {
		return semanticVersion{}, false
	}

	major, err := strconv.Atoi(numbers[0])
	if err != nil {
		return semanticVersion{}, false
	}
	minor, err := strconv.Atoi(numbers[1])
	if err != nil {
		return semanticVersion{}, false
	}
	patch, err := strconv.Atoi(numbers[2])
	if err != nil {
		return semanticVersion{}, false
	}

	return semanticVersion{
		major:      major,
		minor:      minor,
		patch:      patch,
		prerelease: prerelease,
	}, true
}

func compareInt(left, right int) int {
	switch {
	case left < right:
		return -1
	case left > right:
		return 1
	default:
		return 0
	}
}
