package filesystem

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
	"github.com/bmatcuk/doublestar/v4"
	"github.com/djherbis/times"
	"github.com/fsnotify/fsnotify"
)

type Server struct {
	cfg         Config
	tools       []core.Tool
	roots       []Root
	backups     *backupStore
	db          *sql.DB
	watcher     *fsnotify.Watcher
	syncCh      chan syncRequest
	watchedDirs map[string]struct{}
	watchMu     sync.Mutex
	indexSyncMu sync.Mutex
	pathLocks   map[string]*sync.Mutex
	pathLockMu  sync.Mutex
	bg          sync.WaitGroup
	startCtx    context.Context
	startMu     sync.Mutex
	started     bool
	cancel      context.CancelFunc
}

type resolvedPath struct {
	Path   string
	Root   Root
	Exists bool
}

type toolError struct {
	Code             string
	Message          string
	Path             string
	Capability       string
	Access           string
	DenialKind       string
	DenialResolution string
}

func (e *toolError) Error() string {
	return e.Message
}

func (e *toolError) result(toolName, operation string) core.CallResult {
	structured := map[string]interface{}{
		"code":    e.Code,
		"tool":    toolName,
		"path":    e.Path,
		"message": e.Message,
	}
	if operation != "" {
		structured["operation"] = operation
	}
	if strings.TrimSpace(e.Capability) != "" {
		structured["capability"] = e.Capability
	}
	if strings.TrimSpace(e.Access) != "" {
		structured["access"] = e.Access
	}
	if strings.TrimSpace(e.DenialKind) != "" && strings.TrimSpace(e.DenialResolution) != "" {
		structured = core.WithRelayAccessDenial(
			structured,
			e.DenialKind,
			e.DenialResolution,
		)
	}
	return core.CallResult{
		Content:           []interface{}{core.Text(e.Message)},
		StructuredContent: structured,
		IsError:           true,
	}
}

func New(cfg Config) (*Server, error) {
	server := &Server{cfg: cfg}
	roots, err := server.resolveRoots()
	if err != nil {
		return nil, err
	}
	server.roots = roots
	server.backups = newBackupStore(cfg.Backup)
	server.pathLocks = make(map[string]*sync.Mutex)
	server.tools = server.buildTools()
	return server, nil
}

func (s *Server) Start(ctx context.Context) error {
	childCtx, cancel := context.WithCancel(ctx)
	s.startCtx = childCtx
	s.cancel = cancel
	if s.shouldStart(ctx) {
		if err := s.ensureStarted(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) Initialize() error {
	return nil
}

func (s *Server) ListTools() ([]core.Tool, error) {
	tools := make([]core.Tool, len(s.tools))
	copy(tools, s.tools)
	return tools, nil
}

func (s *Server) Shutdown() {
	if s.cancel != nil {
		s.cancel()
	}
	s.bg.Wait()
	s.closeIndex()
	s.started = false
}

func (s *Server) shouldStart(ctx context.Context) bool {
	return s.cfg.Enabled || len(s.effectiveRoots(ctx)) > 0
}

func (s *Server) ensureStarted() error {
	s.startMu.Lock()
	defer s.startMu.Unlock()

	if s.started {
		return nil
	}

	startCtx := s.startCtx
	if startCtx == nil {
		startCtx = context.Background()
	}
	if err := s.openIndex(); err != nil {
		return err
	}
	if err := s.startBackgroundSync(startCtx); err != nil {
		s.closeIndex()
		return err
	}
	s.started = true
	return nil
}

func (s *Server) CallTool(ctx context.Context, toolName string, args map[string]interface{}) (core.CallResult, error) {
	switch toolName {
	case "ListAllowedDirectories":
		return s.listAllowedDirectories(ctx), nil
	case "View":
		return s.viewFile(ctx, args)
	case "ViewMany":
		return s.viewMany(ctx, args)
	case "GetFile":
		return s.getFile(ctx, args)
	case "Replace":
		return s.replaceFile(ctx, args)
	case "Edit":
		return s.editFileContent(ctx, args)
	case "Patch":
		return s.patchTool(ctx, args)
	case "UpdateStructuredData":
		return s.updateStructuredData(ctx, args)
	case "CreateDirectory":
		return s.createDirectory(ctx, args)
	case "LS":
		return s.listFiles(ctx, args)
	case "DirectoryTree":
		return s.directoryTree(ctx, args)
	case "Move":
		return s.moveFile(ctx, args)
	case "Copy":
		return s.copyPath(ctx, args)
	case "Delete":
		return s.deletePath(ctx, args)
	case "Stat":
		return s.getFileInfo(ctx, args)
	case "GlobTool":
		return s.globTool(ctx, args)
	case "GrepTool":
		return s.grepTool(ctx, args)
	case "SearchFiles":
		return s.searchFiles(ctx, args)
	case "ListBackups":
		return s.listBackups(ctx, args)
	case "GetBackup":
		return s.getBackup(ctx, args)
	case "RestoreBackup":
		return s.restoreBackup(ctx, args)
	default:
		return errorResult(fmt.Sprintf("unknown tool: %s", toolName)), nil
	}
}

func (s *Server) resolveRoots() ([]Root, error) {
	switch s.cfg.Scope {
	case "global":
		roots := make([]Root, 0, len(globalRootPaths()))
		for index, path := range globalRootPaths() {
			roots = append(roots, Root{
				ID:     fmt.Sprintf("global_%d", index),
				Path:   filepath.Clean(path),
				Access: normalizeRootAccess(s.cfg.GlobalAccess),
			})
		}
		return roots, nil
	case "roots":
		roots := make([]Root, 0, len(s.cfg.Roots))
		for index, root := range s.cfg.Roots {
			if strings.TrimSpace(root.Path) == "" {
				continue
			}
			absPath, err := filepath.Abs(root.Path)
			if err != nil {
				return nil, fmt.Errorf("resolve root %q: %w", root.Path, err)
			}
			absPath = filepath.Clean(absPath)
			if blockedPath, blocked := s.blockedSystemPath(absPath); blocked {
				return nil, fmt.Errorf("root %q is blocked because it targets a system-managed path %q", root.Path, blockedPath)
			}
			roots = append(roots, Root{
				ID:     fmt.Sprintf("root_%d", index),
				Path:   absPath,
				Access: normalizeRootAccess(root.Access),
			})
		}
		sort.Slice(roots, func(i, j int) bool {
			return len(roots[i].Path) > len(roots[j].Path)
		})
		return roots, nil
	default:
		return nil, fmt.Errorf("unsupported filesystem scope %q", s.cfg.Scope)
	}
}

func (s *Server) effectiveRoots(ctx context.Context) []Root {
	policies := runtimeauth.FilesystemRootsFromPolicies(runtimeauth.PoliciesFromContext(ctx))
	roots := make([]Root, 0, len(s.roots)+len(policies))
	if s.cfg.Enabled {
		for _, root := range s.roots {
			access := root.Access
			roots = append(roots, Root{
				ID:               root.ID,
				Path:             root.Path,
				Access:           access,
				ServerAuthorized: false,
			})
		}
	}
	for policyIndex, policy := range policies {
		for pathIndex, pathPrefix := range policy.PathPrefixes {
			normalizedPath := normalizePathForMatch(pathPrefix)
			if normalizedPath == "" {
				continue
			}
			access := "ro"
			if policy.Access == "write" {
				access = "rw"
			}
			roots = append(roots, Root{
				ID:               fmt.Sprintf("server_authorized_%d_%d", policyIndex, pathIndex),
				Path:             normalizedPath,
				Access:           access,
				ServerAuthorized: true,
			})
		}
	}
	sort.Slice(roots, func(i, j int) bool {
		leftLen := len(roots[i].Path)
		rightLen := len(roots[j].Path)
		if leftLen != rightLen {
			return leftLen > rightLen
		}
		leftRank := rootAccessRank(roots[i].Access)
		rightRank := rootAccessRank(roots[j].Access)
		if leftRank != rightRank {
			return leftRank > rightRank
		}
		if roots[i].ServerAuthorized != roots[j].ServerAuthorized {
			return roots[i].ServerAuthorized
		}
		return roots[i].ID < roots[j].ID
	})
	return roots
}

func normalizeRootAccess(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case "rw", "read_write", "readwrite", "write":
		return "rw"
	case "ro", "read":
		return "ro"
	default:
		return strings.TrimSpace(strings.ToLower(value))
	}
}

func rootAccessRank(value string) int {
	switch normalizeRootAccess(value) {
	case "rw":
		return 2
	case "ro":
		return 1
	default:
		return 0
	}
}

func (s *Server) blockedSystemPath(path string) (string, bool) {
	normalized := normalizePathForMatch(path)
	for _, blocked := range blockedSystemPaths() {
		if blocked == "" {
			continue
		}
		if pathWithinPrefix(normalized, blocked) {
			return blocked, true
		}
	}
	return "", false
}

func (s *Server) matchRoot(path string) (Root, bool) {
	return s.matchRootForContext(context.Background(), path)
}

func (s *Server) matchRootForContext(ctx context.Context, path string) (Root, bool) {
	normalized := normalizePathForMatch(path)
	for _, root := range s.effectiveRoots(ctx) {
		if pathWithinPrefix(normalized, root.Path) {
			return root, true
		}
	}
	return Root{}, false
}

func (s *Server) resolvePath(ctx context.Context, input string, write bool, allowMissing bool) (resolvedPath, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return resolvedPath{}, &toolError{
			Code:             "invalid_arguments",
			Message:          "A non-empty path is required.",
			DenialKind:       core.RelayAccessDenialKindInvalidRequest,
			DenialResolution: core.RelayAccessDenialResolutionUnresolvable,
		}
	}

	if !filepath.IsAbs(input) {
		effectiveRoots := s.effectiveRoots(ctx)
		if s.cfg.Scope == "roots" && len(effectiveRoots) == 1 {
			input = filepath.Join(effectiveRoots[0].Path, input)
		} else {
			return resolvedPath{}, &toolError{
				Code:             "invalid_arguments",
				Message:          "Use an absolute path when more than one root is configured or when the filesystem server is in global mode.",
				DenialKind:       core.RelayAccessDenialKindInvalidRequest,
				DenialResolution: core.RelayAccessDenialResolutionUnresolvable,
			}
		}
	}

	absPath, err := filepath.Abs(input)
	if err != nil {
		return resolvedPath{}, &toolError{
			Code:             "invalid_arguments",
			Message:          fmt.Sprintf("Failed to resolve path %q: %v", input, err),
			Path:             input,
			DenialKind:       core.RelayAccessDenialKindInvalidRequest,
			DenialResolution: core.RelayAccessDenialResolutionUnresolvable,
		}
	}
	absPath = filepath.Clean(absPath)

	if blockedPath, blocked := s.blockedSystemPath(absPath); blocked {
		return resolvedPath{}, &toolError{
			Code:             "system_path_blocked",
			Message:          fmt.Sprintf("Access to %q is blocked because Synapse Relay never exposes system-managed paths such as %q.", absPath, blockedPath),
			Path:             absPath,
			DenialKind:       core.RelayAccessDenialKindRuntimeConstraint,
			DenialResolution: core.RelayAccessDenialResolutionUnresolvable,
		}
	}

	resolved := absPath
	info, statErr := os.Lstat(absPath)
	exists := statErr == nil
	if exists {
		if info != nil && info.Mode()&os.ModeSymlink != 0 {
			return resolvedPath{}, &toolError{
				Code:             "symlink_not_allowed",
				Message:          fmt.Sprintf("The path %q is a symbolic link and cannot be accessed directly by the filesystem server.", absPath),
				Path:             absPath,
				DenialKind:       core.RelayAccessDenialKindRuntimeConstraint,
				DenialResolution: core.RelayAccessDenialResolutionUnresolvable,
			}
		}
		resolved, err = filepath.EvalSymlinks(absPath)
		if err != nil {
			return resolvedPath{}, &toolError{
				Code:             "path_resolution_failed",
				Message:          fmt.Sprintf("Failed to resolve symlinks for %q: %v", absPath, err),
				Path:             absPath,
				DenialKind:       core.RelayAccessDenialKindInvalidRequest,
				DenialResolution: core.RelayAccessDenialResolutionUnresolvable,
			}
		}
	} else if allowMissing && os.IsNotExist(statErr) {
		resolved, err = resolveMissingPath(absPath)
		if err != nil {
			return resolvedPath{}, &toolError{
				Code:             "path_resolution_failed",
				Message:          fmt.Sprintf("Failed to resolve target path %q: %v", absPath, err),
				Path:             absPath,
				DenialKind:       core.RelayAccessDenialKindInvalidRequest,
				DenialResolution: core.RelayAccessDenialResolutionUnresolvable,
			}
		}
	} else if statErr != nil {
		return resolvedPath{}, &toolError{
			Code:             "path_not_found",
			Message:          fmt.Sprintf("The path %q does not exist.", absPath),
			Path:             absPath,
			DenialKind:       core.RelayAccessDenialKindInvalidRequest,
			DenialResolution: core.RelayAccessDenialResolutionUnresolvable,
		}
	}

	if blockedPath, blocked := s.blockedSystemPath(resolved); blocked {
		return resolvedPath{}, &toolError{
			Code:             "system_path_blocked",
			Message:          fmt.Sprintf("Access to %q is blocked because it resolves into the system-managed path %q.", absPath, blockedPath),
			Path:             absPath,
			DenialKind:       core.RelayAccessDenialKindRuntimeConstraint,
			DenialResolution: core.RelayAccessDenialResolutionUnresolvable,
		}
	}

	root, ok := s.matchRootForContext(ctx, resolved)
	if !ok {
		return resolvedPath{}, &toolError{
			Code:             "directory_permission_required",
			Message:          fmt.Sprintf("The path %q is outside the directories exposed by this filesystem server.", absPath),
			Path:             absPath,
			DenialKind:       core.RelayAccessDenialKindPermissionDenied,
			DenialResolution: core.RelayAccessDenialResolutionServerGrant,
		}
	}
	if write {
		if s.cfg.ReadOnly && !root.ServerAuthorized {
			return resolvedPath{}, &toolError{
				Code:             "read_only_mode",
				Message:          "This built-in filesystem server is currently in read-only mode. Read and search tools remain available, but write actions require relay authorization before retrying.",
				Path:             absPath,
				DenialKind:       core.RelayAccessDenialKindPermissionDenied,
				DenialResolution: core.RelayAccessDenialResolutionServerGrant,
			}
		}
		if root.Access != "rw" {
			return resolvedPath{}, &toolError{
				Code:             "write_permission_required",
				Message:          fmt.Sprintf("The path %q is currently configured read-only by the relay client's local policy. Relay authorization is required before retrying the write action.", absPath),
				Path:             absPath,
				DenialKind:       core.RelayAccessDenialKindPermissionDenied,
				DenialResolution: core.RelayAccessDenialResolutionServerGrant,
			}
		}
	}

	return resolvedPath{
		Path:   resolved,
		Root:   root,
		Exists: exists,
	}, nil
}

func resolveMissingPath(absPath string) (string, error) {
	current := absPath
	var suffix []string
	for {
		if _, err := os.Stat(current); err == nil {
			resolved, err := filepath.EvalSymlinks(current)
			if err != nil {
				return "", err
			}
			for index := len(suffix) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, suffix[index])
			}
			return resolved, nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return absPath, nil
		}
		suffix = append(suffix, filepath.Base(current))
		current = parent
	}
}

func (s *Server) listAllowedDirectories(ctx context.Context) core.CallResult {
	entries := make([]AllowedDirectory, 0, len(s.roots))
	for _, root := range s.effectiveRoots(ctx) {
		entries = append(entries, AllowedDirectory{
			ID:     root.ID,
			Path:   root.Path,
			Access: root.Access,
			Scope:  s.cfg.Scope,
		})
	}
	return textResult(
		fmt.Sprintf("Filesystem server exposes %d allowed directories.", len(entries)),
		map[string]interface{}{
			"enabled":     s.cfg.Enabled,
			"scope":       s.cfg.Scope,
			"read_only":   s.cfg.ReadOnly,
			"directories": entries,
		},
	)
}

func requireAbsolutePath(fieldName, value string) error {
	if filepath.IsAbs(strings.TrimSpace(value)) {
		return nil
	}
	return &toolError{
		Code:             "invalid_arguments",
		Message:          fmt.Sprintf("%s must be an absolute path.", fieldName),
		Path:             value,
		DenialKind:       core.RelayAccessDenialKindInvalidRequest,
		DenialResolution: core.RelayAccessDenialResolutionUnresolvable,
	}
}

func currentWorkingDirectory() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Clean(wd), nil
}

func ensureParentDirectory(path string) error {
	parent := filepath.Dir(path)
	info, err := os.Stat(parent)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("parent directory %q does not exist", parent)
		}
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("parent path %q is not a directory", parent)
	}
	return nil
}

func truncateLine(line string, maxChars int) (string, bool) {
	if maxChars <= 0 {
		return line, false
	}
	runes := []rune(line)
	if len(runes) <= maxChars {
		return line, false
	}
	return string(runes[:maxChars]) + "... [truncated]", true
}

func sliceTextByLine(text string, offset, limit int) (string, int, int, bool) {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	if offset < 0 {
		offset = 0
	}
	if offset > len(lines) {
		offset = len(lines)
	}
	if limit <= 0 {
		limit = 2000
	}
	end := offset + limit
	if end > len(lines) {
		end = len(lines)
	}
	selected := make([]string, 0, end-offset)
	truncatedAny := false
	for _, line := range lines[offset:end] {
		truncatedLine, truncated := truncateLine(line, 2000)
		if truncated {
			truncatedAny = true
		}
		selected = append(selected, truncatedLine)
	}
	return strings.Join(selected, "\n"), len(lines), end - offset, truncatedAny
}

func (s *Server) resolveOptionalSearchPath(ctx context.Context, input string) (resolvedPath, error) {
	if strings.TrimSpace(input) == "" {
		wd, err := currentWorkingDirectory()
		if err != nil {
			return resolvedPath{}, &toolError{
				Code:             "invalid_arguments",
				Message:          fmt.Sprintf("Failed to resolve current working directory: %v", err),
				DenialKind:       core.RelayAccessDenialKindInvalidRequest,
				DenialResolution: core.RelayAccessDenialResolutionUnresolvable,
			}
		}
		input = wd
	}
	return s.resolvePath(ctx, input, false, false)
}

type listedEntry struct {
	Name       string
	Path       string
	IsDir      bool
	SizeBytes  int64
	ModifiedAt string
	ModTime    time.Time
}

func (s *Server) viewFile(ctx context.Context, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		FilePath string `json:"file_path"`
		Offset   int    `json:"offset"`
		Limit    int    `json:"limit"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid View arguments: %v", err)), nil
	}
	viewed, err := s.readViewFile(ctx, input.FilePath, input.Offset, input.Limit)
	if err != nil {
		if toolErr, ok := err.(*toolError); ok {
			return toolErr.result("View", "read"), nil
		}
		return errorResult(err.Error()), nil
	}
	return textResult(viewed.Text, viewed.Structured), nil
}

func (s *Server) replaceFile(ctx context.Context, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		FilePath string `json:"file_path"`
		Content  string `json:"content"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid Replace arguments: %v", err)), nil
	}
	if err := requireAbsolutePath("file_path", input.FilePath); err != nil {
		return toolResultError("Replace", "replace", err), nil
	}

	resolved, err := s.resolvePath(ctx, input.FilePath, true, true)
	if err != nil {
		return toolResultError("Replace", "replace", err), nil
	}
	unlock := s.lockPaths([]string{resolved.Path})
	defer unlock()
	backups, err := s.captureBackups([]string{resolved.Path}, "replace")
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to prepare backups for Replace: %v", err)), nil
	}
	if err := writeTextFile(resolved.Path, input.Content); err != nil {
		return errorResultWithBackups(fmt.Sprintf("Failed to replace %q: %v", resolved.Path, err), map[string]interface{}{
			"file_path": resolved.Path,
		}, backups), nil
	}
	s.syncAfterMutation(resolved.Path, false)
	return textResultWithBackups(fmt.Sprintf("Replaced %q.", resolved.Path), map[string]interface{}{
		"file_path": resolved.Path,
	}, backups), nil
}

func (s *Server) editFileContent(ctx context.Context, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		FilePath  string `json:"file_path"`
		OldString string `json:"old_string"`
		NewString string `json:"new_string"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid Edit arguments: %v", err)), nil
	}
	if err := requireAbsolutePath("file_path", input.FilePath); err != nil {
		return toolResultError("Edit", "edit", err), nil
	}

	trimmedOld := input.OldString
	if trimmedOld == "" {
		resolved, err := s.resolvePath(ctx, input.FilePath, true, true)
		if err != nil {
			return toolResultError("Edit", "edit", err), nil
		}
		unlock := s.lockPaths([]string{resolved.Path})
		defer unlock()
		if resolved.Exists {
			return errorResult("old_string must not be empty when editing an existing file. Use Replace to overwrite the file."), nil
		}
		backups, err := s.captureBackups([]string{resolved.Path}, "edit")
		if err != nil {
			return errorResult(fmt.Sprintf("Failed to prepare backups for Edit: %v", err)), nil
		}
		if err := writeTextFile(resolved.Path, input.NewString); err != nil {
			return errorResultWithBackups(fmt.Sprintf("Failed to create %q: %v", resolved.Path, err), map[string]interface{}{
				"file_path": resolved.Path,
				"created":   true,
			}, backups), nil
		}
		s.syncAfterMutation(resolved.Path, false)
		return textResultWithBackups(fmt.Sprintf("Created %q.", resolved.Path), map[string]interface{}{
			"file_path": resolved.Path,
			"created":   true,
		}, backups), nil
	}

	resolved, err := s.resolvePath(ctx, input.FilePath, true, false)
	if err != nil {
		return toolResultError("Edit", "edit", err), nil
	}
	unlock := s.lockPaths([]string{resolved.Path})
	defer unlock()
	content, err := loadEditableTextFile(resolved.Path)
	if err != nil {
		return errorResult(err.Error()), nil
	}
	matches := strings.Count(content, input.OldString)
	switch {
	case matches == 0:
		return errorResult(fmt.Sprintf("old_string was not found in %q.", resolved.Path)), nil
	case matches > 1:
		return errorResult(fmt.Sprintf("old_string matched %d locations in %q. Provide more surrounding context so the replacement is unique.", matches, resolved.Path)), nil
	}
	content = strings.Replace(content, input.OldString, input.NewString, 1)
	backups, err := s.captureBackups([]string{resolved.Path}, "edit")
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to prepare backups for Edit: %v", err)), nil
	}
	if err := writeTextFile(resolved.Path, content); err != nil {
		return errorResultWithBackups(fmt.Sprintf("Failed to edit %q: %v", resolved.Path, err), map[string]interface{}{
			"file_path": resolved.Path,
		}, backups), nil
	}
	s.syncAfterMutation(resolved.Path, false)
	return textResultWithBackups(fmt.Sprintf("Edited %q.", resolved.Path), map[string]interface{}{
		"file_path": resolved.Path,
	}, backups), nil
}

func (s *Server) listFiles(ctx context.Context, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		DirectoryPath string `json:"directory_path"`
		Offset        int    `json:"offset"`
		Limit         int    `json:"limit"`
		SortBy        string `json:"sort_by"`
		SortDirection string `json:"sort_direction"`
		NameContains  string `json:"name_contains"`
		EntryType     string `json:"entry_type"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid LS arguments: %v", err)), nil
	}
	if err := requireAbsolutePath("directory_path", input.DirectoryPath); err != nil {
		return toolResultError("LS", "list", err), nil
	}

	resolved, err := s.resolvePath(ctx, input.DirectoryPath, false, false)
	if err != nil {
		return toolResultError("LS", "list", err), nil
	}
	info, err := os.Stat(resolved.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to stat %q: %v", resolved.Path, err)), nil
	}
	if !info.IsDir() {
		return errorResult(fmt.Sprintf("%q is not a directory.", resolved.Path)), nil
	}

	entries, err := os.ReadDir(resolved.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to list %q: %v", resolved.Path, err)), nil
	}

	filter := strings.ToLower(strings.TrimSpace(input.NameContains))
	entryType := strings.TrimSpace(strings.ToLower(input.EntryType))
	if entryType == "" {
		entryType = "all"
	}

	items := make([]listedEntry, 0, len(entries))
	for _, entry := range entries {
		childPath := filepath.Join(resolved.Path, entry.Name())
		if _, blocked := s.blockedSystemPath(childPath); blocked {
			continue
		}
		if filter != "" && !strings.Contains(strings.ToLower(entry.Name()), filter) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		switch entryType {
		case "file":
			if info.IsDir() {
				continue
			}
		case "directory":
			if !info.IsDir() {
				continue
			}
		}
		items = append(items, listedEntry{
			Name:       entry.Name(),
			Path:       childPath,
			IsDir:      info.IsDir(),
			SizeBytes:  info.Size(),
			ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
			ModTime:    info.ModTime(),
		})
	}

	sortBy := strings.TrimSpace(strings.ToLower(input.SortBy))
	if sortBy == "" {
		sortBy = "name"
	}
	sortDirection := strings.TrimSpace(strings.ToLower(input.SortDirection))
	if sortDirection == "" {
		if sortBy == "modified_at" || sortBy == "size" {
			sortDirection = "desc"
		} else {
			sortDirection = "asc"
		}
	}
	desc := sortDirection == "desc"

	sort.Slice(items, func(i, j int) bool {
		compare := 0
		switch sortBy {
		case "modified_at":
			switch {
			case items[i].ModTime.Before(items[j].ModTime):
				compare = -1
			case items[i].ModTime.After(items[j].ModTime):
				compare = 1
			}
		case "size":
			switch {
			case items[i].SizeBytes < items[j].SizeBytes:
				compare = -1
			case items[i].SizeBytes > items[j].SizeBytes:
				compare = 1
			}
		case "type":
			leftType := 1
			rightType := 1
			if items[i].IsDir {
				leftType = 0
			}
			if items[j].IsDir {
				rightType = 0
			}
			switch {
			case leftType < rightType:
				compare = -1
			case leftType > rightType:
				compare = 1
			}
		default:
		}
		if compare == 0 {
			switch {
			case items[i].Name < items[j].Name:
				compare = -1
			case items[i].Name > items[j].Name:
				compare = 1
			}
		}
		if compare == 0 {
			switch {
			case items[i].Path < items[j].Path:
				compare = -1
			case items[i].Path > items[j].Path:
				compare = 1
			}
		}
		if desc {
			return compare > 0
		}
		return compare < 0
	})

	if input.Offset < 0 {
		input.Offset = 0
	}
	if input.Limit <= 0 {
		input.Limit = 200
	}
	if input.Limit > 1000 {
		input.Limit = 1000
	}
	total := len(items)
	start := input.Offset
	if start > total {
		start = total
	}
	end := start + input.Limit
	if end > total {
		end = total
	}
	paged := items[start:end]

	lines := make([]string, 0, len(paged))
	structuredEntries := make([]map[string]interface{}, 0, len(paged))
	for _, item := range paged {
		prefix := "file"
		if item.IsDir {
			prefix = "dir"
		}
		lines = append(lines, fmt.Sprintf("[%s] %s", prefix, item.Path))
		structuredEntries = append(structuredEntries, map[string]interface{}{
			"name":        item.Name,
			"path":        item.Path,
			"is_dir":      item.IsDir,
			"size_bytes":  item.SizeBytes,
			"modified_at": item.ModifiedAt,
		})
	}

	return textResult(strings.Join(lines, "\n"), map[string]interface{}{
		"directory_path": resolved.Path,
		"entries":        structuredEntries,
		"total":          total,
		"offset":         start,
		"limit":          input.Limit,
		"has_more":       end < total,
		"sort_by":        sortBy,
		"sort_direction": sortDirection,
		"name_contains":  input.NameContains,
		"entry_type":     entryType,
	}), nil
}

func (s *Server) globTool(ctx context.Context, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Pattern          string   `json:"pattern"`
		Path             string   `json:"path"`
		Exclude          []string `json:"exclude"`
		RespectGitignore bool     `json:"respect_gitignore"`
		Limit            int      `json:"limit"`
		Offset           int      `json:"offset"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid GlobTool arguments: %v", err)), nil
	}
	if strings.TrimSpace(input.Pattern) == "" {
		return errorResult("pattern is required."), nil
	}
	if input.Offset < 0 {
		return errorResult("offset must be greater than or equal to 0."), nil
	}
	if input.Limit < 0 {
		return errorResult("limit must be greater than or equal to 0."), nil
	}
	if input.Limit > 1000 {
		input.Limit = 1000
	}

	root, err := s.resolveOptionalSearchPath(ctx, input.Path)
	if err != nil {
		return toolResultError("GlobTool", "read", err), nil
	}
	info, err := os.Stat(root.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to stat %q: %v", root.Path, err)), nil
	}

	filterRoot := root.Path
	if !info.IsDir() {
		filterRoot = filepath.Dir(root.Path)
	}
	pathFilter, err := newPathSearchFilter(filterRoot, input.Exclude, input.RespectGitignore)
	if err != nil {
		return errorResult(fmt.Sprintf("Glob failed to compile path filters: %v", err)), nil
	}

	backend := "walk_fallback"
	matches := make([]matchedPath, 0)
	if info.IsDir() {
		rgMatches, rgErr := s.globMatchesWithRipgrep(ctx, root.Path, input.Pattern, pathFilter, input.Exclude, input.RespectGitignore)
		if rgErr == nil {
			matches = rgMatches
			backend = "ripgrep"
		} else {
			fallbackMatches, fallbackErr := s.globMatches(root.Path, info, input.Pattern, pathFilter)
			if fallbackErr != nil {
				return errorResult(fmt.Sprintf("Glob failed: %v", rgErr)), nil
			}
			matches = fallbackMatches
		}
	} else {
		matches, err = s.globMatches(root.Path, info, input.Pattern, pathFilter)
		if err != nil {
			return errorResult(fmt.Sprintf("Glob failed: %v", err)), nil
		}
	}
	sortMatchedPaths(matches)
	paged, total, hasMore, appliedOffset, appliedLimit := paginateMatchedPaths(matches, input.Offset, input.Limit)
	return matchedPathResult(input.Pattern, root.Path, paged, total, appliedOffset, appliedLimit, hasMore, backend), nil
}

func (s *Server) grepTool(ctx context.Context, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Pattern          string   `json:"pattern"`
		Path             string   `json:"path"`
		Include          string   `json:"include"`
		Exclude          []string `json:"exclude"`
		OutputMode       string   `json:"output_mode"`
		RespectGitignore bool     `json:"respect_gitignore"`
		CaseInsensitive  bool     `json:"case_insensitive"`
		Multiline        bool     `json:"multiline"`
		HeadLimit        *int     `json:"head_limit"`
		Offset           int      `json:"offset"`
		MaxMatches       int      `json:"max_matches"`
		ContextBefore    int      `json:"context_before"`
		ContextAfter     int      `json:"context_after"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid GrepTool arguments: %v", err)), nil
	}
	if strings.TrimSpace(input.Pattern) == "" {
		return errorResult("pattern is required."), nil
	}
	outputMode := normalizeGrepOutputMode(input.OutputMode)
	if outputMode == "" {
		return errorResult(fmt.Sprintf("output_mode must be one of %q, %q, or %q.", grepOutputModeFilesWithMatches, grepOutputModeContent, grepOutputModeCount)), nil
	}
	if input.Offset < 0 {
		return errorResult("offset must be greater than or equal to 0."), nil
	}
	if input.HeadLimit != nil && *input.HeadLimit < 0 {
		return errorResult("head_limit must be greater than or equal to 0."), nil
	}
	headLimit, unlimitedHeadLimit := resolveGrepHeadLimit(input.HeadLimit)

	compiledPattern := input.Pattern
	flagPrefix := ""
	if input.CaseInsensitive {
		flagPrefix += "i"
	}
	if input.Multiline {
		flagPrefix += "s"
	}
	if flagPrefix != "" {
		compiledPattern = "(?" + flagPrefix + ")" + compiledPattern
	}

	re, err := regexp.Compile(compiledPattern)
	if err != nil {
		return errorResult(fmt.Sprintf("Invalid regular expression %q: %v", input.Pattern, err)), nil
	}

	root, err := s.resolveOptionalSearchPath(ctx, input.Path)
	if err != nil {
		return toolResultError("GrepTool", "read", err), nil
	}
	info, err := os.Stat(root.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to stat %q: %v", root.Path, err)), nil
	}
	filterRoot := root.Path
	if !info.IsDir() {
		filterRoot = filepath.Dir(root.Path)
	}
	pathFilter, err := newPathSearchFilter(filterRoot, input.Exclude, input.RespectGitignore)
	if err != nil {
		return errorResult(fmt.Sprintf("Grep failed to compile path filters: %v", err)), nil
	}

	if input.MaxMatches <= 0 {
		input.MaxMatches = defaultGrepHeadLimit
	}
	if input.MaxMatches > 5000 {
		input.MaxMatches = 5000
	}
	if input.ContextBefore < 0 {
		input.ContextBefore = 0
	}
	if input.ContextBefore > 20 {
		input.ContextBefore = 20
	}
	if input.ContextAfter < 0 {
		input.ContextAfter = 0
	}
	if input.ContextAfter > 20 {
		input.ContextAfter = 20
	}

	backend := "walk_fallback"
	switch outputMode {
	case grepOutputModeFilesWithMatches:
		fileMatches, err := s.grepFilePathsWithRipgrep(ctx, root.Path, info, input.Pattern, input.Include, pathFilter, input.Exclude, input.RespectGitignore, input.CaseInsensitive, input.Multiline)
		truncated := false
		if err == nil {
			backend = "ripgrep"
			start, end, appliedOffset, appliedHeadLimit, hasMore := paginateSearchWindow(len(fileMatches), input.Offset, headLimit, unlimitedHeadLimit)
			return grepFilesWithMatchesResult(input.Pattern, root.Path, fileMatches[start:end], len(fileMatches), appliedOffset, appliedHeadLimit, hasMore, truncated, backend), nil
		}

		matches, fallbackTruncated, fallbackErr := s.grepMatchesDetailed(root.Path, info, re, input.Include, pathFilter, input.MaxMatches, 0, 0)
		if fallbackErr != nil {
			return errorResult(fmt.Sprintf("Grep failed: %v", fallbackErr)), nil
		}
		truncated = fallbackTruncated
		fileMatches = grepMatchedPathsFromFileMatches(matches)
		start, end, appliedOffset, appliedHeadLimit, hasMore := paginateSearchWindow(len(fileMatches), input.Offset, headLimit, unlimitedHeadLimit)
		return grepFilesWithMatchesResult(input.Pattern, root.Path, fileMatches[start:end], len(fileMatches), appliedOffset, appliedHeadLimit, hasMore, truncated, backend), nil
	case grepOutputModeCount:
		countEntries, err := s.grepCountEntriesWithRipgrep(ctx, root.Path, info, input.Pattern, input.Include, pathFilter, input.Exclude, input.RespectGitignore, input.CaseInsensitive, input.Multiline)
		truncated := false
		if err == nil {
			backend = "ripgrep"
			totalMatches := 0
			for _, entry := range countEntries {
				totalMatches += entry.MatchCount
			}
			start, end, appliedOffset, appliedHeadLimit, hasMore := paginateSearchWindow(len(countEntries), input.Offset, headLimit, unlimitedHeadLimit)
			return grepCountResult(input.Pattern, root.Path, countEntries[start:end], len(countEntries), totalMatches, appliedOffset, appliedHeadLimit, hasMore, truncated, backend), nil
		}

		matches, fallbackTruncated, fallbackErr := s.grepMatchesDetailed(root.Path, info, re, input.Include, pathFilter, input.MaxMatches, 0, 0)
		if fallbackErr != nil {
			return errorResult(fmt.Sprintf("Grep failed: %v", fallbackErr)), nil
		}
		truncated = fallbackTruncated
		countEntries = grepCountEntriesFromFileMatches(matches)
		totalMatches := 0
		for _, entry := range countEntries {
			totalMatches += entry.MatchCount
		}
		start, end, appliedOffset, appliedHeadLimit, hasMore := paginateSearchWindow(len(countEntries), input.Offset, headLimit, unlimitedHeadLimit)
		return grepCountResult(input.Pattern, root.Path, countEntries[start:end], len(countEntries), totalMatches, appliedOffset, appliedHeadLimit, hasMore, truncated, backend), nil
	default:
		matches, truncated, err := s.grepMatchesDetailedWithRipgrep(ctx, root.Path, info, re, input.Pattern, input.Include, pathFilter, input.Exclude, input.RespectGitignore, input.CaseInsensitive, input.Multiline, input.MaxMatches, input.ContextBefore, input.ContextAfter)
		if err == nil {
			backend = "ripgrep"
		} else {
			matches, truncated, err = s.grepMatchesDetailed(root.Path, info, re, input.Include, pathFilter, input.MaxMatches, input.ContextBefore, input.ContextAfter)
			if err != nil {
				return errorResult(fmt.Sprintf("Grep failed: %v", err)), nil
			}
		}
		sortGrepFileMatches(matches)
		contentEntries := flattenGrepContentEntries(matches)
		start, end, appliedOffset, appliedHeadLimit, hasMore := paginateSearchWindow(len(contentEntries), input.Offset, headLimit, unlimitedHeadLimit)
		return grepContentResult(input.Pattern, root.Path, contentEntries[start:end], len(contentEntries), input.MaxMatches, appliedOffset, appliedHeadLimit, hasMore, truncated, backend), nil
	}
}

func (s *Server) getFile(ctx context.Context, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		FilePath string `json:"file_path"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid GetFile arguments: %v", err)), nil
	}
	if err := requireAbsolutePath("file_path", input.FilePath); err != nil {
		return toolResultError("GetFile", "read", err), nil
	}

	resolved, err := s.resolvePath(ctx, input.FilePath, false, false)
	if err != nil {
		return toolResultError("GetFile", "read", err), nil
	}

	info, err := os.Stat(resolved.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to stat %q: %v", resolved.Path, err)), nil
	}
	if info.IsDir() {
		return errorResult(fmt.Sprintf("%q is a directory. Use LS or DirectoryTree instead.", resolved.Path)), nil
	}
	if !info.Mode().IsRegular() {
		return errorResult(fmt.Sprintf("%q is not a regular file and cannot be returned as an attachment.", resolved.Path)), nil
	}

	maxSizeBytes := s.cfg.MaxGetFileSizeBytes
	if maxSizeBytes <= 0 {
		maxSizeBytes = 20 * 1024 * 1024
	}
	if info.Size() > maxSizeBytes {
		return errorResult(fmt.Sprintf("The file %q is %d bytes, which exceeds the configured GetFile limit of %d bytes.", resolved.Path, info.Size(), maxSizeBytes)), nil
	}

	data, err := os.ReadFile(resolved.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to read %q: %v", resolved.Path, err)), nil
	}
	if int64(len(data)) > maxSizeBytes {
		return errorResult(fmt.Sprintf("The file %q grew beyond the configured GetFile limit of %d bytes while being read.", resolved.Path, maxSizeBytes)), nil
	}

	mimeType := detectFileMimeType(resolved.Path, data)
	encoded := base64.StdEncoding.EncodeToString(data)
	sha256Sum := sha256.Sum256(data)
	sha256Hex := hex.EncodeToString(sha256Sum[:])
	fileMetadata := buildGetFileMetadata(resolved.Path, info, sha256Hex)
	return core.CallResult{
		Content: []interface{}{
			core.Text(fmt.Sprintf("Retrieved %q as an attachment (%d bytes, %s).", resolved.Path, len(data), mimeType)),
			core.BinaryResource(filepath.Base(resolved.Path), mimeType, encoded, fileMetadata),
		},
		StructuredContent: map[string]interface{}{
			"file_path":   resolved.Path,
			"name":        filepath.Base(resolved.Path),
			"mime_type":   mimeType,
			"size_bytes":  len(data),
			"sha256":      sha256Hex,
			"modified_at": fileMetadata["modifiedAt"],
			"created_at":  fileMetadata["createdAt"],
			"root_id":     resolved.Root.ID,
			"access":      resolved.Root.Access,
		},
	}, nil
}

func (s *Server) createDirectory(ctx context.Context, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		DirectoryPath string `json:"directory_path"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid CreateDirectory arguments: %v", err)), nil
	}
	if err := requireAbsolutePath("directory_path", input.DirectoryPath); err != nil {
		return toolResultError("CreateDirectory", "write", err), nil
	}
	resolved, err := s.resolvePath(ctx, input.DirectoryPath, true, true)
	if err != nil {
		return toolResultError("CreateDirectory", "write", err), nil
	}
	unlock := s.lockPaths([]string{resolved.Path})
	defer unlock()
	var backups []backupResult
	if !resolved.Exists {
		backups, err = s.captureBackups([]string{resolved.Path}, "create_directory")
		if err != nil {
			return errorResult(fmt.Sprintf("Failed to prepare backups for CreateDirectory: %v", err)), nil
		}
	}
	if err := os.MkdirAll(resolved.Path, 0o755); err != nil {
		return errorResultWithBackups(fmt.Sprintf("Failed to create %q: %v", resolved.Path, err), map[string]interface{}{
			"directory_path": resolved.Path,
		}, backups), nil
	}
	s.syncAfterMutation(resolved.Path, true)
	return textResultWithBackups(fmt.Sprintf("Created %q.", resolved.Path), map[string]interface{}{"directory_path": resolved.Path}, backups), nil
}

func (s *Server) directoryTree(ctx context.Context, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		DirectoryPath string `json:"directory_path"`
		MaxDepth      int    `json:"max_depth"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid DirectoryTree arguments: %v", err)), nil
	}
	if input.MaxDepth <= 0 {
		input.MaxDepth = 4
	}
	if err := requireAbsolutePath("directory_path", input.DirectoryPath); err != nil {
		return toolResultError("DirectoryTree", "list", err), nil
	}
	resolved, err := s.resolvePath(ctx, input.DirectoryPath, false, false)
	if err != nil {
		return toolResultError("DirectoryTree", "list", err), nil
	}
	tree, lines, err := s.buildDirectoryTree(resolved.Path, input.MaxDepth, 0)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to build tree for %q: %v", resolved.Path, err)), nil
	}
	return textResult(strings.Join(lines, "\n"), tree), nil
}

func (s *Server) buildDirectoryTree(path string, maxDepth, depth int) (map[string]interface{}, []string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	node := map[string]interface{}{
		"name":   filepath.Base(path),
		"path":   path,
		"is_dir": info.IsDir(),
	}
	linePrefix := strings.Repeat("  ", depth)
	lines := []string{fmt.Sprintf("%s%s", linePrefix, filepath.Base(path))}
	if !info.IsDir() || depth >= maxDepth {
		return node, lines, nil
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	children := make([]map[string]interface{}, 0, len(entries))
	for _, entry := range entries {
		childPath := filepath.Join(path, entry.Name())
		if _, blocked := s.blockedSystemPath(childPath); blocked {
			continue
		}
		childNode, childLines, err := s.buildDirectoryTree(childPath, maxDepth, depth+1)
		if err != nil {
			continue
		}
		children = append(children, childNode)
		lines = append(lines, childLines...)
	}
	node["children"] = children
	return node, lines, nil
}

func (s *Server) moveFile(ctx context.Context, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		SourcePath      string `json:"source_path"`
		DestinationPath string `json:"destination_path"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid Move arguments: %v", err)), nil
	}
	if err := requireAbsolutePath("source_path", input.SourcePath); err != nil {
		return toolResultError("Move", "write", err), nil
	}
	if err := requireAbsolutePath("destination_path", input.DestinationPath); err != nil {
		return toolResultError("Move", "write", err), nil
	}
	source, err := s.resolvePath(ctx, input.SourcePath, true, false)
	if err != nil {
		return toolResultError("Move", "write", err), nil
	}
	destination, err := s.resolvePath(ctx, input.DestinationPath, true, true)
	if err != nil {
		return toolResultError("Move", "write", err), nil
	}
	unlock := s.lockPaths([]string{source.Path, destination.Path})
	defer unlock()
	if source.Path == destination.Path {
		return errorResult("source_path and destination_path must be different."), nil
	}
	sourceInfo, err := os.Stat(source.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to stat %q: %v", source.Path, err)), nil
	}
	if sourceInfo.IsDir() && pathWithinPrefix(normalizePathForMatch(destination.Path), normalizePathForMatch(source.Path)) {
		return errorResult("destination_path cannot be inside source_path when moving a directory."), nil
	}
	backupPaths := []string{source.Path}
	if destination.Path != source.Path {
		backupPaths = append(backupPaths, destination.Path)
	}
	backups, err := s.captureBackups(backupPaths, "move")
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to prepare backups for Move: %v", err)), nil
	}
	if err := os.MkdirAll(filepath.Dir(destination.Path), 0o755); err != nil {
		return errorResultWithBackups(fmt.Sprintf("Failed to create parent directory for %q: %v", destination.Path, err), map[string]interface{}{
			"source_path":      source.Path,
			"destination_path": destination.Path,
		}, backups), nil
	}
	if err := os.Rename(source.Path, destination.Path); err != nil {
		return errorResultWithBackups(fmt.Sprintf("Failed to move %q to %q: %v", source.Path, destination.Path, err), map[string]interface{}{
			"source_path":      source.Path,
			"destination_path": destination.Path,
		}, backups), nil
	}
	s.syncAfterMutation(source.Path, false)
	s.syncAfterMutation(destination.Path, sourceInfo.IsDir())
	return textResultWithBackups(fmt.Sprintf("Moved %q to %q.", source.Path, destination.Path), map[string]interface{}{
		"source_path":      source.Path,
		"destination_path": destination.Path,
	}, backups), nil
}

func (s *Server) getFileInfo(ctx context.Context, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Path string `json:"path"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid Stat arguments: %v", err)), nil
	}
	if err := requireAbsolutePath("path", input.Path); err != nil {
		return toolResultError("Stat", "read", err), nil
	}
	resolved, err := s.resolvePath(ctx, input.Path, false, false)
	if err != nil {
		return toolResultError("Stat", "read", err), nil
	}
	info, err := os.Stat(resolved.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to stat %q: %v", resolved.Path, err)), nil
	}
	result := map[string]interface{}{
		"path":        resolved.Path,
		"name":        filepath.Base(resolved.Path),
		"is_dir":      info.IsDir(),
		"size_bytes":  info.Size(),
		"mode":        info.Mode().String(),
		"modified_at": info.ModTime().UTC().Format(time.RFC3339),
		"root_id":     resolved.Root.ID,
		"access":      resolved.Root.Access,
	}
	return textResult(fmt.Sprintf("Retrieved metadata for %q.", resolved.Path), result), nil
}

func (s *Server) searchFiles(ctx context.Context, args map[string]interface{}) (core.CallResult, error) {
	var input SearchQuery
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid SearchFiles arguments: %v", err)), nil
	}
	if !s.started {
		if !s.shouldStart(ctx) {
			requestPath := strings.TrimSpace(input.Path)
			if requestPath == "" {
				if cwd, err := currentWorkingDirectory(); err == nil {
					requestPath = cwd
				}
			}
			return toolResultError("SearchFiles", "read", &toolError{
				Code:    "search_unavailable",
				Message: fmt.Sprintf("Search is not enabled for %q because this filesystem server does not currently expose any searchable directories.", requestPath),
				Path:    requestPath,
			}), nil
		}
		if err := s.ensureStarted(); err != nil {
			return errorResult(fmt.Sprintf("Search failed: %v", err)), nil
		}
	}
	results, err := s.searchIndex(ctx, input)
	if err != nil {
		return errorResult(fmt.Sprintf("Search failed: %v", err)), nil
	}
	lines := make([]string, 0, len(results))
	for _, result := range results {
		line := fmt.Sprintf("[%s %.1f] %s", result.MatchMode, result.Score, result.Path)
		if result.Snippet != "" {
			line += " :: " + result.Snippet
		}
		lines = append(lines, line)
	}
	return textResult(strings.Join(lines, "\n"), map[string]interface{}{
		"query":               input.Query,
		"mode":                input.Mode,
		"results":             results,
		"filters":             input,
		"freshness_guarantee": "eventually_consistent",
	}), nil
}

type matchedPath struct {
	Path       string
	ModifiedAt string
	ModTime    time.Time
}

func sortMatchedPaths(matches []matchedPath) {
	sort.Slice(matches, func(i, j int) bool {
		if !matches[i].ModTime.Equal(matches[j].ModTime) {
			return matches[i].ModTime.After(matches[j].ModTime)
		}
		return matches[i].Path < matches[j].Path
	})
}

func matchedPathResult(pattern, root string, matches []matchedPath, total, offset, limit int, hasMore bool, backend string) core.CallResult {
	lines := make([]string, 0, len(matches))
	structuredMatches := make([]map[string]interface{}, 0, len(matches))
	for _, match := range matches {
		lines = append(lines, match.Path)
		structuredMatches = append(structuredMatches, map[string]interface{}{
			"path":        match.Path,
			"modified_at": match.ModifiedAt,
		})
	}
	return textResult(strings.Join(lines, "\n"), map[string]interface{}{
		"pattern":             pattern,
		"path":                root,
		"matches":             structuredMatches,
		"total":               total,
		"offset":              offset,
		"limit":               limit,
		"has_more":            hasMore,
		"backend":             backend,
		"freshness_guarantee": "current_filesystem",
	})
}

func (s *Server) globMatches(root string, rootInfo os.FileInfo, pattern string, pathFilter *pathSearchFilter) ([]matchedPath, error) {
	pattern = strings.TrimSpace(pattern)
	matches := make([]matchedPath, 0)

	if !rootInfo.IsDir() {
		if pathFilter != nil && pathFilter.Skip(root, false) {
			return matches, nil
		}
		rel := filepath.Base(root)
		ok, err := doublestar.PathMatch(pattern, filepath.ToSlash(rel))
		if err != nil {
			return nil, err
		}
		if ok {
			matches = append(matches, matchedPath{
				Path:       root,
				ModifiedAt: rootInfo.ModTime().UTC().Format(time.RFC3339),
				ModTime:    rootInfo.ModTime(),
			})
		}
		return matches, nil
	}

	err := filepath.WalkDir(root, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if current == root {
			return nil
		}
		if _, blocked := s.blockedSystemPath(current); blocked {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			if pathFilter != nil && pathFilter.Skip(current, true) {
				return filepath.SkipDir
			}
			return nil
		}
		if pathFilter != nil && pathFilter.Skip(current, false) {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(root, current)
		if err != nil {
			return nil
		}
		ok, err := doublestar.PathMatch(pattern, filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		if ok {
			matches = append(matches, matchedPath{
				Path:       current,
				ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
				ModTime:    info.ModTime(),
			})
		}
		return nil
	})
	return matches, err
}

func (s *Server) grepMatches(root string, rootInfo os.FileInfo, re *regexp.Regexp, include string) ([]matchedPath, error) {
	include = strings.TrimSpace(include)
	matches := make([]matchedPath, 0)

	matchInclude := func(rel string) (bool, error) {
		if include == "" {
			return true, nil
		}
		normalized := filepath.ToSlash(rel)
		ok, err := doublestar.PathMatch(include, normalized)
		if err != nil || ok {
			return ok, err
		}
		return doublestar.PathMatch(include, filepath.Base(normalized))
	}

	searchFile := func(path string, info os.FileInfo, rel string) error {
		allowed, err := matchInclude(rel)
		if err != nil || !allowed {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil || !looksLikeText(path, data) {
			return nil
		}
		if re.Match(data) {
			matches = append(matches, matchedPath{
				Path:       path,
				ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
				ModTime:    info.ModTime(),
			})
		}
		return nil
	}

	if !rootInfo.IsDir() {
		if err := searchFile(root, rootInfo, filepath.Base(root)); err != nil {
			return nil, err
		}
		return matches, nil
	}

	err := filepath.WalkDir(root, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if current == root {
			return nil
		}
		if _, blocked := s.blockedSystemPath(current); blocked {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(root, current)
		if err != nil {
			return nil
		}
		return searchFile(current, info, rel)
	})
	return matches, err
}

func decodeArgs(input map[string]interface{}, target interface{}) error {
	if len(input) == 0 {
		return nil
	}
	data, err := json.Marshal(input)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func detectFileMimeType(path string, data []byte) string {
	extMime := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	if extMime != "" {
		if mediaType, _, err := mime.ParseMediaType(extMime); err == nil && mediaType != "" {
			return mediaType
		}
		return extMime
	}

	if len(data) == 0 {
		return "application/octet-stream"
	}
	if len(data) > 512 {
		data = data[:512]
	}
	return http.DetectContentType(data)
}

func buildGetFileMetadata(path string, info os.FileInfo, sha256Hex string) map[string]interface{} {
	metadata := map[string]interface{}{
		"absolutePath": path,
		"sha256":       sha256Hex,
		"sizeBytes":    info.Size(),
		"modifiedAt":   info.ModTime().UTC().Format(time.RFC3339),
	}

	if statTimes, err := times.Stat(path); err == nil && statTimes.HasBirthTime() {
		metadata["createdAt"] = statTimes.BirthTime().UTC().Format(time.RFC3339)
	}

	return metadata
}

func textResult(text string, structured interface{}) core.CallResult {
	return core.CallResult{
		Content:           []interface{}{core.Text(text)},
		StructuredContent: structured,
	}
}

func errorResult(text string) core.CallResult {
	return core.CallResult{
		Content: []interface{}{core.Text(text)},
		IsError: true,
	}
}

func toolResultError(toolName, operation string, err error) core.CallResult {
	if toolErr, ok := err.(*toolError); ok {
		return toolErr.result(toolName, operation)
	}
	return errorResult(err.Error())
}
