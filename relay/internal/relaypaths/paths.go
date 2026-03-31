package relaypaths

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

type HostKind string

const (
	HostStandalone HostKind = "standalone"
	HostIM         HostKind = "im"
	HostCLI        HostKind = "cli"
)

const standaloneProfileID = "standalone-default"

type HostPaths struct {
	HostKind     HostKind
	SharedRoot   string
	ProfilesRoot string
	PackagedRoot string
	TempRoot     string
}

type ProfileDescriptor struct {
	HostKind      HostKind
	ServerBaseURL string
	UserID        string
	WorkspaceID   string
	ProfileID     string
	DisplayName   string
}

type ResolvedPaths struct {
	HostPaths            HostPaths
	Descriptor           ProfileDescriptor
	ProfileID            string
	ProfileRoot          string
	ConfigPath           string
	PrivateKeyPath       string
	LogsDir              string
	StateDir             string
	RuntimeAuthPath      string
	OperationJournalPath string
	BrowsersDir          string
	FilesystemIndexesDir string
	FilesystemBackupsDir string
	SharedRuntimeRoot    string
	UpdatesRoot          string
	ControlPlanePath     string
}

var (
	currentMu    sync.RWMutex
	currentPaths *ResolvedPaths
)

func DefaultHostPaths(kind HostKind) HostPaths {
	baseRoot := defaultBaseRoot()
	hostName := strings.TrimSpace(string(kind))
	if hostName == "" {
		hostName = string(HostStandalone)
	}
	return HostPaths{
		HostKind:     kind,
		SharedRoot:   filepath.Join(baseRoot, "shared"),
		ProfilesRoot: filepath.Join(baseRoot, hostName, "profiles"),
		TempRoot:     filepath.Join(baseRoot, "tmp"),
	}
}

func ResolveStandaloneProfile(hostPaths HostPaths) ResolvedPaths {
	if hostPaths.HostKind == "" {
		hostPaths.HostKind = HostStandalone
	}
	return resolve(hostPaths, ProfileDescriptor{
		HostKind:  hostPaths.HostKind,
		ProfileID: standaloneProfileID,
	})
}

func ResolveIMProfile(hostPaths HostPaths, descriptor ProfileDescriptor) ResolvedPaths {
	if hostPaths.HostKind == "" {
		hostPaths.HostKind = HostIM
	}
	descriptor.HostKind = hostPaths.HostKind
	if strings.TrimSpace(descriptor.ProfileID) == "" {
		descriptor.ProfileID = IMProfileID(descriptor.ServerBaseURL, descriptor.UserID, descriptor.WorkspaceID)
	}
	return resolve(hostPaths, descriptor)
}

func IMProfileID(serverBaseURL, userID, workspaceID string) string {
	normalized := strings.TrimSpace(strings.ToLower(serverBaseURL))
	payload := strings.Join([]string{
		normalized,
		strings.TrimSpace(userID),
		strings.TrimSpace(workspaceID),
	}, "\x1f")
	sum := sha256.Sum256([]byte(payload))
	return "im_" + hex.EncodeToString(sum[:16])
}

func SetCurrent(paths ResolvedPaths) {
	clone := paths
	currentMu.Lock()
	currentPaths = &clone
	currentMu.Unlock()
}

func Current() ResolvedPaths {
	currentMu.RLock()
	if currentPaths != nil {
		clone := *currentPaths
		currentMu.RUnlock()
		return clone
	}
	currentMu.RUnlock()
	return ResolveStandaloneProfile(DefaultHostPaths(HostStandalone))
}

func Ensure(paths ResolvedPaths) error {
	dirs := []string{
		paths.HostPaths.SharedRoot,
		paths.HostPaths.TempRoot,
		paths.ProfileRoot,
		paths.LogsDir,
		paths.StateDir,
		paths.BrowsersDir,
		paths.FilesystemIndexesDir,
		paths.FilesystemBackupsDir,
		paths.SharedRuntimeRoot,
		paths.UpdatesRoot,
	}
	for _, dir := range dirs {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func resolve(hostPaths HostPaths, descriptor ProfileDescriptor) ResolvedPaths {
	profileID := strings.TrimSpace(descriptor.ProfileID)
	if profileID == "" {
		profileID = standaloneProfileID
	}
	profileRoot := filepath.Join(hostPaths.ProfilesRoot, profileID)
	sharedRuntimeRoot := filepath.Join(hostPaths.SharedRoot, "runtime")
	updatesRoot := filepath.Join(hostPaths.SharedRoot, "updates")
	stateDir := filepath.Join(profileRoot, "state")

	return ResolvedPaths{
		HostPaths:            hostPaths,
		Descriptor:           descriptor,
		ProfileID:            profileID,
		ProfileRoot:          profileRoot,
		ConfigPath:           filepath.Join(profileRoot, "config.yaml"),
		PrivateKeyPath:       filepath.Join(profileRoot, "device-key.pem"),
		LogsDir:              filepath.Join(profileRoot, "logs"),
		StateDir:             stateDir,
		RuntimeAuthPath:      filepath.Join(profileRoot, "runtime-authorizations.json"),
		OperationJournalPath: filepath.Join(profileRoot, "operation-journal.json"),
		BrowsersDir:          filepath.Join(profileRoot, "browsers"),
		FilesystemIndexesDir: filepath.Join(profileRoot, "indexes"),
		FilesystemBackupsDir: filepath.Join(profileRoot, "backups"),
		SharedRuntimeRoot:    sharedRuntimeRoot,
		UpdatesRoot:          updatesRoot,
		ControlPlanePath:     controlPlanePath(stateDir, profileID),
	}
}

func defaultBaseRoot() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".synapse/relay"
	}
	return filepath.Join(home, ".synapse", "relay")
}

func controlPlanePath(stateDir, profileID string) string {
	if runtime.GOOS == "windows" {
		return `\\.\pipe\synapse-relay-` + profileID + `-agent`
	}
	return filepath.Join(stateDir, "relay-agent.sock")
}
