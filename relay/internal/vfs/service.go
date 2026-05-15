package vfs

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
)

var (
	ErrNotFound     = errors.New("relay vfs path not found")
	ErrNotDirectory = errors.New("relay vfs path is not a directory")
	ErrIsDirectory  = errors.New("relay vfs path is a directory")
)

type Service struct {
	paths    relaypaths.ResolvedPaths
	backend  Backend
	exposure map[string]Exposure
	cuaTree  cuaSemanticProvider

	mu         sync.Mutex
	sessions   map[string]*SessionState
	sessionSeq uint64
}

func New(paths relaypaths.ResolvedPaths, cfg *config.Config) (*Service, error) {
	backend, err := NewManagerBackend(paths, cfg)
	if err != nil {
		return nil, err
	}
	return NewWithBackend(paths, backend), nil
}

func NewWithBackend(paths relaypaths.ResolvedPaths, backend Backend) *Service {
	return &Service{
		paths:    paths,
		backend:  backend,
		exposure: make(map[string]Exposure),
		cuaTree:  newCUASemanticProvider(paths),
		sessions: make(map[string]*SessionState),
	}
}

func (s *Service) Start(ctx context.Context) error {
	if err := s.backend.Start(ctx); err != nil {
		return err
	}

	exposures := s.backend.Exposures()
	s.exposure = make(map[string]Exposure, len(exposures))
	for _, exposure := range exposures {
		s.exposure[exposureKey(exposure.Capability, exposure.StableKey)] = exposure
	}
	return nil
}

func (s *Service) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	s.mu.Lock()
	sessions := make([]*SessionState, 0, len(s.sessions))
	for _, session := range s.sessions {
		sessions = append(sessions, session)
	}
	s.mu.Unlock()

	for _, session := range sessions {
		_ = s.backend.CloseRuntimeSession(ctx, session.RuntimeSessionID)
	}
	s.backend.Close()
}

func (s *Service) List(pathValue string) ([]Entry, error) {
	cleanPath, err := normalizePath(pathValue)
	if err != nil {
		return nil, err
	}
	segments := splitPath(cleanPath)

	switch len(segments) {
	case 0:
		return []Entry{
			dirEntry("/browser", "browser"),
			dirEntry("/cua", "cua"),
		}, nil
	case 1:
		if segments[0] != "browser" && segments[0] != "cua" {
			return nil, ErrNotFound
		}
		return s.listCapability(segments[0])
	}

	capability := segments[0]
	stableKey := segments[1]
	exposure, err := s.requireExposure(capability, stableKey)
	if err != nil {
		return nil, err
	}

	switch {
	case len(segments) == 2:
		return []Entry{
			fileEntry(path.Join("/", capability, stableKey, "metadata.json"), "metadata.json", "application/json", false),
			dirEntry(path.Join("/", capability, stableKey, "sessions"), "sessions"),
		}, nil
	case len(segments) == 3:
		switch segments[2] {
		case "sessions":
			return s.listSessions(capability, stableKey), nil
		case "metadata.json":
			return nil, ErrNotDirectory
		default:
			return nil, ErrNotFound
		}
	default:
		if segments[2] != "sessions" {
			return nil, ErrNotFound
		}
		sessionID := segments[3]
		session, err := s.ensureSession(context.Background(), capability, stableKey, sessionID)
		if err != nil {
			return nil, err
		}
		remainder := segments[4:]
		switch capability {
		case "browser":
			return s.listBrowserSession(exposure, session, remainder)
		case "cua":
			return s.listCUASession(exposure, session, remainder)
		default:
			return nil, ErrNotFound
		}
	}
}

func (s *Service) Stat(pathValue string) (Entry, error) {
	cleanPath, err := normalizePath(pathValue)
	if err != nil {
		return Entry{}, err
	}
	if cleanPath == "/" {
		return Entry{Name: "/", Path: "/", Kind: NodeKindDirectory, ModTime: time.Now()}, nil
	}

	parent := path.Dir(cleanPath)
	name := path.Base(cleanPath)
	entries, err := s.List(parent)
	if err != nil {
		return Entry{}, err
	}
	for _, entry := range entries {
		if entry.Name == name {
			return entry, nil
		}
	}
	return Entry{}, ErrNotFound
}

func (s *Service) Read(pathValue string) (ReadResult, error) {
	cleanPath, err := normalizePath(pathValue)
	if err != nil {
		return ReadResult{}, err
	}
	segments := splitPath(cleanPath)
	if len(segments) == 0 {
		return ReadResult{}, ErrIsDirectory
	}
	if len(segments) == 3 && segments[2] == "metadata.json" {
		exposure, err := s.requireExposure(segments[0], segments[1])
		if err != nil {
			return ReadResult{}, err
		}
		data, err := jsonBytes(exposure)
		if err != nil {
			return ReadResult{}, err
		}
		return ReadResult{Data: data, MimeType: "application/json"}, nil
	}
	if len(segments) == 4 && segments[2] == "sessions" && segments[3] == "create" {
		text := strings.Join([]string{
			"Write a session id or JSON payload to this control file to create or open a relay VFS session.",
			"",
			"Examples:",
			`  echo "demo-session" | synapse-relay vfs write /browser/<stable>/sessions/create`,
			`  echo '{"sessionId":"demo-session"}' | synapse-relay vfs write /cua/<stable>/sessions/create`,
		}, "\n")
		return ReadResult{Data: []byte(text + "\n"), MimeType: "text/plain; charset=utf-8"}, nil
	}
	if len(segments) < 5 || segments[2] != "sessions" {
		return ReadResult{}, ErrIsDirectory
	}

	capability := segments[0]
	stableKey := segments[1]
	sessionID := segments[3]
	session, err := s.ensureSession(context.Background(), capability, stableKey, sessionID)
	if err != nil {
		return ReadResult{}, err
	}
	exposure, err := s.requireExposure(capability, stableKey)
	if err != nil {
		return ReadResult{}, err
	}

	switch capability {
	case "browser":
		return s.readBrowser(exposure, session, segments[4:])
	case "cua":
		return s.readCUA(exposure, session, segments[4:])
	default:
		return ReadResult{}, ErrNotFound
	}
}

func (s *Service) Write(pathValue string, data []byte) (WriteResult, error) {
	cleanPath, err := normalizePath(pathValue)
	if err != nil {
		return WriteResult{}, err
	}
	segments := splitPath(cleanPath)
	if len(segments) == 4 && segments[2] == "sessions" && segments[3] == "create" {
		return s.writeSessionCreate(segments[0], segments[1], data)
	}
	if len(segments) < 5 || segments[2] != "sessions" {
		return WriteResult{}, ErrNotFound
	}

	capability := segments[0]
	stableKey := segments[1]
	if len(segments) == 5 && segments[4] == "close" {
		return s.writeSessionClose(capability, stableKey, segments[3])
	}
	sessionID := segments[3]
	session, err := s.ensureSession(context.Background(), capability, stableKey, sessionID)
	if err != nil {
		return WriteResult{}, err
	}
	exposure, err := s.requireExposure(capability, stableKey)
	if err != nil {
		return WriteResult{}, err
	}

	switch capability {
	case "browser":
		return s.writeBrowser(exposure, session, segments[4:], data)
	case "cua":
		return s.writeCUA(exposure, session, segments[4:], data)
	default:
		return WriteResult{}, ErrNotFound
	}
}

func (s *Service) listCapability(capability string) ([]Entry, error) {
	entries := make([]Entry, 0)
	for _, exposure := range s.backend.Exposures() {
		if exposure.Capability != capability {
			continue
		}
		entries = append(entries, dirEntry(path.Join("/", capability, exposure.StableKey), exposure.StableKey))
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name < entries[j].Name
	})
	return entries, nil
}

func (s *Service) listSessions(capability, stableKey string) []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()

	keys := []string{"default"}
	seen := map[string]struct{}{"default": {}}
	for _, session := range s.sessions {
		if session.Capability != capability || session.ExposureStableKey != stableKey {
			continue
		}
		if _, ok := seen[session.SessionID]; ok {
			continue
		}
		seen[session.SessionID] = struct{}{}
		keys = append(keys, session.SessionID)
	}
	sort.Strings(keys)

	entries := make([]Entry, 0, len(keys))
	entries = append(entries, fileEntry(path.Join("/", capability, stableKey, "sessions", "create"), "create", "text/plain; charset=utf-8", true))
	for _, key := range keys {
		entries = append(entries, dirEntry(path.Join("/", capability, stableKey, "sessions", key), key))
	}
	return entries
}

func (s *Service) requireExposure(capability, stableKey string) (Exposure, error) {
	exposure, ok := s.exposure[exposureKey(capability, stableKey)]
	if !ok {
		return Exposure{}, ErrNotFound
	}
	return exposure, nil
}

func (s *Service) ensureSession(
	ctx context.Context,
	capability string,
	stableKey string,
	sessionID string,
) (*SessionState, error) {
	if strings.TrimSpace(sessionID) == "" {
		sessionID = "default"
	}
	if err := validateSessionID(sessionID); err != nil {
		return nil, err
	}
	key := sessionKey(capability, stableKey, sessionID)

	s.mu.Lock()
	if session, ok := s.sessions[key]; ok {
		s.mu.Unlock()
		return session, nil
	}
	runtimeSessionID := fmt.Sprintf("relayfs:%s:%s:%s", capability, stableKey, sessionID)
	session := &SessionState{
		Capability:        capability,
		ExposureStableKey: stableKey,
		SessionID:         sessionID,
		RuntimeSessionID:  runtimeSessionID,
		CreatedAt:         time.Now(),
	}
	s.sessions[key] = session
	s.mu.Unlock()

	if err := s.backend.OpenRuntimeSession(ctx, stableKey, runtimeSessionID); err != nil {
		s.mu.Lock()
		delete(s.sessions, key)
		s.mu.Unlock()
		return nil, err
	}
	return session, nil
}

func (s *Service) closeSession(capability, stableKey, sessionID string) (*SessionState, error) {
	key := sessionKey(capability, stableKey, sessionID)

	s.mu.Lock()
	session, ok := s.sessions[key]
	if ok {
		delete(s.sessions, key)
	}
	s.mu.Unlock()
	if !ok {
		return nil, ErrNotFound
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.backend.CloseRuntimeSession(ctx, session.RuntimeSessionID); err != nil {
		return nil, err
	}
	return session, nil
}

func (s *Service) writeSessionCreate(capability, stableKey string, data []byte) (WriteResult, error) {
	if _, err := s.requireExposure(capability, stableKey); err != nil {
		return WriteResult{}, err
	}
	requestedID, err := parseSessionCreatePayload(data)
	if err != nil {
		return WriteResult{}, err
	}
	if requestedID == "" {
		requestedID = s.nextGeneratedSessionID()
	}
	session, err := s.ensureSession(context.Background(), capability, stableKey, requestedID)
	if err != nil {
		return WriteResult{}, err
	}
	response, err := jsonBytes(map[string]interface{}{
		"created":   true,
		"path":      path.Join("/", capability, stableKey, "sessions", session.SessionID),
		"sessionId": session.SessionID,
		"session":   session,
	})
	if err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Data: response, MimeType: "application/json"}, nil
}

func (s *Service) writeSessionClose(capability, stableKey, sessionID string) (WriteResult, error) {
	session, err := s.closeSession(capability, stableKey, sessionID)
	if err != nil {
		return WriteResult{}, err
	}
	response, err := jsonBytes(map[string]interface{}{
		"closed":    true,
		"path":      path.Join("/", capability, stableKey, "sessions", sessionID),
		"sessionId": sessionID,
		"session":   session,
	})
	if err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Data: response, MimeType: "application/json"}, nil
}

func (s *Service) callTool(
	ctx context.Context,
	exposureStableKey string,
	toolName string,
	args map[string]interface{},
) (*toolResult, error) {
	raw, err := s.backend.CallTool(ctx, exposureStableKey, toolName, args)
	if err != nil {
		return nil, err
	}
	result, err := decodeToolResult(raw)
	if err != nil {
		return nil, err
	}
	if result.IsError {
		if text := result.Text(); text != "" {
			return nil, fmt.Errorf("%s", text)
		}
		if len(result.StructuredContent) > 0 {
			return nil, fmt.Errorf("%s", strings.TrimSpace(string(result.StructuredContent)))
		}
		return nil, fmt.Errorf("%s failed", toolName)
	}
	return result, nil
}

func (s *Service) callSessionTool(
	ctx context.Context,
	session *SessionState,
	exposureStableKey string,
	toolName string,
	args map[string]interface{},
) (*toolResult, error) {
	if session != nil && session.RuntimeSessionID != "" {
		ctx = runtimeauth.ContextWithRuntimeSessionID(ctx, session.RuntimeSessionID)
	}
	return s.callTool(ctx, exposureStableKey, toolName, args)
}

func normalizePath(input string) (string, error) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return "/", nil
	}
	if strings.HasPrefix(trimmed, "relayfs://") {
		parsed, err := url.Parse(trimmed)
		if err != nil {
			return "", err
		}
		trimmed = path.Join("/", parsed.Host, parsed.Path)
	}
	if !strings.HasPrefix(trimmed, "/") {
		trimmed = "/" + trimmed
	}
	return path.Clean(trimmed), nil
}

func splitPath(value string) []string {
	if value == "/" {
		return nil
	}
	trimmed := strings.Trim(value, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func jsonBytes(value interface{}) ([]byte, error) {
	return json.MarshalIndent(value, "", "  ")
}

func dirEntry(pathValue, name string) Entry {
	return Entry{
		Name:    name,
		Path:    pathValue,
		Kind:    NodeKindDirectory,
		ModTime: time.Now(),
	}
}

func fileEntry(pathValue, name, mimeType string, writable bool) Entry {
	return Entry{
		Name:     name,
		Path:     pathValue,
		Kind:     NodeKindFile,
		MimeType: mimeType,
		Writable: writable,
		ModTime:  time.Now(),
	}
}

func exposureKey(capability, stableKey string) string {
	return capability + ":" + stableKey
}

func sessionKey(capability, stableKey, sessionID string) string {
	return exposureKey(capability, stableKey) + ":" + sessionID
}

type toolResult struct {
	Content           []map[string]interface{} `json:"content"`
	StructuredContent json.RawMessage          `json:"structuredContent"`
	IsError           bool                     `json:"isError"`
}

func decodeToolResult(raw interface{}) (*toolResult, error) {
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var result toolResult
	if err := json.Unmarshal(encoded, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (r *toolResult) Text() string {
	lines := make([]string, 0, len(r.Content))
	for _, item := range r.Content {
		if item["type"] != "text" {
			continue
		}
		text, _ := item["text"].(string)
		if strings.TrimSpace(text) == "" {
			continue
		}
		lines = append(lines, text)
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func (r *toolResult) FirstImage() ([]byte, string, error) {
	for _, item := range r.Content {
		if item["type"] != "image" {
			continue
		}
		encoded, _ := item["data"].(string)
		mimeType, _ := item["mimeType"].(string)
		if encoded == "" {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, "", err
		}
		return data, mimeType, nil
	}
	return nil, "", fmt.Errorf("no image content returned")
}

func resultEnvelope(result *toolResult) (map[string]interface{}, error) {
	envelope := map[string]interface{}{
		"isError": result.IsError,
		"content": result.Content,
	}
	if hasStructuredContent(result.StructuredContent) {
		var structured interface{}
		if err := json.Unmarshal(result.StructuredContent, &structured); err != nil {
			envelope["structuredContentText"] = strings.TrimSpace(string(result.StructuredContent))
		} else {
			envelope["structuredContent"] = structured
		}
	}
	text := result.Text()
	if text != "" {
		envelope["text"] = text
	}
	return envelope, nil
}

func decodeStructuredContent[T any](result *toolResult) (T, error) {
	var value T
	if !hasStructuredContent(result.StructuredContent) {
		return value, fmt.Errorf("tool result does not include structured content")
	}
	if err := json.Unmarshal(result.StructuredContent, &value); err != nil {
		return value, err
	}
	return value, nil
}

func hasStructuredContent(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	return !bytes.Equal(trimmed, []byte("null"))
}

func writeTempFile(dir, pattern string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return os.CreateTemp(dir, pattern)
}

func parseSessionCreatePayload(data []byte) (string, error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return "", nil
	}
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") || trimmed == "null" {
		var payload map[string]interface{}
		if err := json.Unmarshal(data, &payload); err != nil {
			return "", fmt.Errorf("session create payload must be valid JSON or a plain-text session id: %w", err)
		}
		if payload == nil {
			return "", nil
		}
		if raw, ok := payload["sessionId"]; ok {
			sessionID, ok := raw.(string)
			if !ok {
				return "", fmt.Errorf("sessionId must be a string")
			}
			return strings.TrimSpace(sessionID), nil
		}
		return "", nil
	}
	return trimmed, nil
}

func validateSessionID(sessionID string) error {
	if strings.TrimSpace(sessionID) == "" {
		return fmt.Errorf("session id must not be empty")
	}
	if sessionID == "." || sessionID == ".." {
		return fmt.Errorf("session id %q is reserved", sessionID)
	}
	for _, r := range sessionID {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '.', r == '-', r == '_':
		default:
			return fmt.Errorf("session id %q contains unsupported character %q", sessionID, r)
		}
	}
	return nil
}

func (s *Service) nextGeneratedSessionID() string {
	s.mu.Lock()
	s.sessionSeq++
	seq := s.sessionSeq
	s.mu.Unlock()
	return fmt.Sprintf("session-%s-%03d", time.Now().UTC().Format("20060102t150405"), seq)
}
