package runtimeauth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
)

type Grant struct {
	InteractionID     string `json:"interactionId"`
	RuntimeSessionID  string `json:"-"`
	ExposureStableKey string `json:"exposureStableKey"`
	Duration          string `json:"duration"`
	Capability        string `json:"capability"`
	Path              string `json:"path,omitempty"`
	Access            string `json:"access,omitempty"`
	Mode              string `json:"mode,omitempty"`
	Reason            string `json:"reason,omitempty"`
	GrantedAt         string `json:"grantedAt"`
}

type RuntimeSession struct {
	ID                string
	ExposureStableKey string
	CreatedAt         string
}

type FilesystemGrant struct {
	Path   string
	Access string
}

type storeFile struct {
	Grants []Grant `json:"grants"`
}

type Store struct {
	path             string
	mu               sync.RWMutex
	persistentGrants map[string]Grant
	sessionGrants    map[string]map[string]Grant
	sessions         map[string]RuntimeSession
}

func NewStore(path string) *Store {
	if strings.TrimSpace(path) == "" {
		path = relaypaths.Current().RuntimeAuthPath
	}
	s := &Store{
		path:             path,
		persistentGrants: make(map[string]Grant),
		sessionGrants:    make(map[string]map[string]Grant),
		sessions:         make(map[string]RuntimeSession),
	}
	s.load()
	return s
}

func (s *Store) OpenSession(session RuntimeSession) error {
	session.ID = strings.TrimSpace(session.ID)
	session.ExposureStableKey = strings.TrimSpace(session.ExposureStableKey)
	if session.ID == "" {
		return fmt.Errorf("runtime session id is required")
	}
	if session.ExposureStableKey == "" {
		return fmt.Errorf("exposure stable key is required")
	}
	if strings.TrimSpace(session.CreatedAt) == "" {
		session.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, ok := s.sessions[session.ID]; ok {
		if existing.ExposureStableKey != session.ExposureStableKey {
			return fmt.Errorf(
				"runtime session %q is already bound to exposure %q",
				session.ID,
				existing.ExposureStableKey,
			)
		}
		return nil
	}

	s.sessions[session.ID] = session
	return nil
}

func (s *Store) CloseSession(runtimeSessionID string) {
	runtimeSessionID = strings.TrimSpace(runtimeSessionID)
	if runtimeSessionID == "" {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, runtimeSessionID)
	delete(s.sessionGrants, runtimeSessionID)
}

func (s *Store) ResetSessions() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions = make(map[string]RuntimeSession)
	s.sessionGrants = make(map[string]map[string]Grant)
}

func (s *Store) Apply(grant Grant) error {
	if strings.TrimSpace(grant.InteractionID) == "" {
		return fmt.Errorf("interaction id is required")
	}
	if strings.TrimSpace(grant.ExposureStableKey) == "" {
		return fmt.Errorf("exposure stable key is required")
	}

	grant.Duration = normalizeDuration(grant.Duration)
	if grant.Duration == "" {
		return fmt.Errorf("duration must be session or persistent")
	}
	grant.Capability = strings.TrimSpace(strings.ToLower(grant.Capability))
	switch grant.Capability {
	case "filesystem":
		grant.Path = filepath.Clean(strings.TrimSpace(grant.Path))
		grant.Access = normalizeFilesystemAccess(grant.Access)
		if grant.Path == "" || grant.Path == "." {
			return fmt.Errorf("filesystem path is required")
		}
		if grant.Access == "" {
			return fmt.Errorf("filesystem access must be read, write, or read_write")
		}
	case "cua":
		grant.Mode = strings.TrimSpace(strings.ToLower(grant.Mode))
		if grant.Mode == "" {
			grant.Mode = "control"
		}
		if grant.Mode != "control" {
			return fmt.Errorf("unsupported cua mode %q", grant.Mode)
		}
	case "chrome":
		if grant.Duration != "persistent" {
			return fmt.Errorf("chrome authorization must be persistent")
		}
	default:
		return fmt.Errorf("unsupported capability %q", grant.Capability)
	}
	if strings.TrimSpace(grant.GrantedAt) == "" {
		grant.GrantedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if grant.Duration == "persistent" {
		grant.RuntimeSessionID = ""
		s.persistentGrants[grant.InteractionID] = grant
		s.saveLocked()
		return nil
	}

	runtimeSessionID := strings.TrimSpace(grant.RuntimeSessionID)
	if runtimeSessionID == "" {
		return fmt.Errorf("runtime session id is required for session authorization")
	}
	session, ok := s.sessions[runtimeSessionID]
	if !ok {
		return fmt.Errorf("runtime session %q is not active", runtimeSessionID)
	}
	if session.ExposureStableKey != grant.ExposureStableKey {
		return fmt.Errorf(
			"runtime session %q is bound to exposure %q, not %q",
			runtimeSessionID,
			session.ExposureStableKey,
			grant.ExposureStableKey,
		)
	}

	if s.sessionGrants[runtimeSessionID] == nil {
		s.sessionGrants[runtimeSessionID] = make(map[string]Grant)
	}
	s.sessionGrants[runtimeSessionID][grant.InteractionID] = grant
	return nil
}

func (s *Store) FilesystemGrants(exposureStableKey, runtimeSessionID string) []FilesystemGrant {
	s.mu.RLock()
	defer s.mu.RUnlock()

	grants := make([]FilesystemGrant, 0)
	for _, grant := range s.persistentGrants {
		if grant.ExposureStableKey != exposureStableKey || grant.Capability != "filesystem" {
			continue
		}
		grants = append(grants, FilesystemGrant{
			Path:   grant.Path,
			Access: grant.Access,
		})
	}

	runtimeSessionID = strings.TrimSpace(runtimeSessionID)
	if runtimeSessionID != "" {
		if session, ok := s.sessions[runtimeSessionID]; ok && session.ExposureStableKey == exposureStableKey {
			for _, grant := range s.sessionGrants[runtimeSessionID] {
				if grant.Capability != "filesystem" {
					continue
				}
				grants = append(grants, FilesystemGrant{
					Path:   grant.Path,
					Access: grant.Access,
				})
			}
		}
	}

	sort.Slice(grants, func(i, j int) bool {
		return len(grants[i].Path) > len(grants[j].Path)
	})
	return grants
}

func (s *Store) AllowsCUAControl(exposureStableKey, runtimeSessionID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, grant := range s.persistentGrants {
		if grant.ExposureStableKey == exposureStableKey && grant.Capability == "cua" && grant.Mode == "control" {
			return true
		}
	}

	runtimeSessionID = strings.TrimSpace(runtimeSessionID)
	if runtimeSessionID == "" {
		return false
	}
	session, ok := s.sessions[runtimeSessionID]
	if !ok || session.ExposureStableKey != exposureStableKey {
		return false
	}
	for _, grant := range s.sessionGrants[runtimeSessionID] {
		if grant.Capability == "cua" && grant.Mode == "control" {
			return true
		}
	}

	return false
}

func (s *Store) AllowsChromeAutomation(exposureStableKey string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, grant := range s.persistentGrants {
		if grant.ExposureStableKey == exposureStableKey && grant.Capability == "chrome" {
			return true
		}
	}

	return false
}

func normalizeDuration(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case "session":
		return "session"
	case "persistent":
		return "persistent"
	default:
		return ""
	}
}

func normalizeFilesystemAccess(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case "read":
		return "read"
	case "write":
		return "write"
	case "read_write", "readwrite", "rw":
		return "read_write"
	default:
		return ""
	}
}

func (s *Store) load() {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}

	var payload storeFile
	if err := json.Unmarshal(data, &payload); err != nil {
		return
	}

	for _, grant := range payload.Grants {
		if normalizeDuration(grant.Duration) != "persistent" {
			continue
		}
		grant.Duration = "persistent"
		grant.Capability = strings.TrimSpace(strings.ToLower(grant.Capability))
		grant.RuntimeSessionID = ""
		s.persistentGrants[grant.InteractionID] = grant
	}
}

func (s *Store) saveLocked() {
	persisted := make([]Grant, 0, len(s.persistentGrants))
	for _, grant := range s.persistentGrants {
		if grant.Duration != "persistent" {
			continue
		}
		grant.RuntimeSessionID = ""
		persisted = append(persisted, grant)
	}
	sort.Slice(persisted, func(i, j int) bool {
		if persisted[i].ExposureStableKey == persisted[j].ExposureStableKey {
			return persisted[i].InteractionID < persisted[j].InteractionID
		}
		return persisted[i].ExposureStableKey < persisted[j].ExposureStableKey
	})

	if err := os.MkdirAll(filepath.Dir(s.path), 0755); err != nil {
		return
	}

	data, err := json.MarshalIndent(storeFile{Grants: persisted}, "", "  ")
	if err != nil {
		return
	}

	tmpPath := s.path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return
	}
	_ = os.Rename(tmpPath, s.path)
}
