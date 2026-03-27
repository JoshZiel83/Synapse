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
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
	"github.com/djherbis/times"
	"github.com/fsnotify/fsnotify"
)

type Server struct {
	cfg         Config
	tools       []core.Tool
	roots       []Root
	db          *sql.DB
	watcher     *fsnotify.Watcher
	syncCh      chan syncRequest
	watchedDirs map[string]struct{}
	watchMu     sync.Mutex
	bg          sync.WaitGroup
	cancel      context.CancelFunc
}

type resolvedPath struct {
	Path   string
	Root   Root
	Exists bool
}

type toolError struct {
	Code                 string
	Message              string
	Path                 string
	RequiresUserApproval bool
	ClientHint           string
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
	if e.RequiresUserApproval {
		structured["requires_user_approval"] = true
	}
	if strings.TrimSpace(e.ClientHint) != "" {
		structured["client_hint"] = e.ClientHint
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
	server.tools = server.buildTools()
	return server, nil
}

func (s *Server) Start(ctx context.Context) error {
	childCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	if err := s.openIndex(); err != nil {
		return err
	}
	if err := s.startBackgroundSync(childCtx); err != nil {
		s.closeIndex()
		return err
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
}

func (s *Server) CallTool(ctx context.Context, toolName string, args map[string]interface{}) (core.CallResult, error) {
	runtimeSessionID := runtimeauth.RuntimeSessionIDFromContext(ctx)
	switch toolName {
	case "list_allowed_directories":
		return s.listAllowedDirectories(runtimeSessionID), nil
	case "read_text_file":
		return s.readTextFile(runtimeSessionID, args)
	case "get_file":
		return s.getFile(runtimeSessionID, args)
	case "read_multiple_files":
		return s.readMultipleFiles(runtimeSessionID, args)
	case "write_file":
		return s.writeFile(runtimeSessionID, args)
	case "edit_file":
		return s.editFile(runtimeSessionID, args)
	case "create_directory":
		return s.createDirectory(runtimeSessionID, args)
	case "list_directory":
		return s.listDirectory(runtimeSessionID, args)
	case "directory_tree":
		return s.directoryTree(runtimeSessionID, args)
	case "move_file":
		return s.moveFile(runtimeSessionID, args)
	case "get_file_info":
		return s.getFileInfo(runtimeSessionID, args)
	case "search_files":
		return s.searchFiles(ctx, runtimeSessionID, args)
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

func (s *Server) effectiveRoots() []Root {
	return s.effectiveRootsForSession("")
}

func (s *Server) effectiveRootsForSession(runtimeSessionID string) []Root {
	roots := make([]Root, len(s.roots))
	copy(roots, s.roots)
	if s.cfg.AuthStore != nil && strings.TrimSpace(s.cfg.StableKey) != "" {
		for index, grant := range s.cfg.AuthStore.FilesystemGrants(s.cfg.StableKey, runtimeSessionID) {
			roots = append(roots, Root{
				ID:     fmt.Sprintf("grant_%d", index),
				Path:   filepath.Clean(grant.Path),
				Access: normalizeRootAccess(grant.Access),
			})
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
			return roots[i].ID < roots[j].ID
		})
	}
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
	return s.matchRootForSession("", path)
}

func (s *Server) matchRootForSession(runtimeSessionID, path string) (Root, bool) {
	normalized := normalizePathForMatch(path)
	for _, root := range s.effectiveRootsForSession(runtimeSessionID) {
		if pathWithinPrefix(normalized, root.Path) {
			return root, true
		}
	}
	return Root{}, false
}

func (s *Server) resolvePath(runtimeSessionID, input string, write bool, allowMissing bool) (resolvedPath, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return resolvedPath{}, &toolError{Code: "invalid_arguments", Message: "A non-empty path is required."}
	}

	if !filepath.IsAbs(input) {
		if s.cfg.Scope == "roots" && len(s.roots) == 1 {
			input = filepath.Join(s.roots[0].Path, input)
		} else {
			return resolvedPath{}, &toolError{
				Code:    "invalid_arguments",
				Message: "Use an absolute path when more than one root is configured or when the filesystem server is in global mode.",
			}
		}
	}

	absPath, err := filepath.Abs(input)
	if err != nil {
		return resolvedPath{}, &toolError{Code: "invalid_arguments", Message: fmt.Sprintf("Failed to resolve path %q: %v", input, err), Path: input}
	}
	absPath = filepath.Clean(absPath)

	if blockedPath, blocked := s.blockedSystemPath(absPath); blocked {
		return resolvedPath{}, &toolError{
			Code:    "system_path_blocked",
			Message: fmt.Sprintf("Access to %q is blocked because Synapse Relay never exposes system-managed paths such as %q.", absPath, blockedPath),
			Path:    absPath,
		}
	}

	resolved := absPath
	info, statErr := os.Stat(absPath)
	exists := statErr == nil
	if exists {
		resolved, err = filepath.EvalSymlinks(absPath)
		if err != nil {
			return resolvedPath{}, &toolError{Code: "path_resolution_failed", Message: fmt.Sprintf("Failed to resolve symlinks for %q: %v", absPath, err), Path: absPath}
		}
	} else if allowMissing && os.IsNotExist(statErr) {
		resolved, err = resolveMissingPath(absPath)
		if err != nil {
			return resolvedPath{}, &toolError{Code: "path_resolution_failed", Message: fmt.Sprintf("Failed to resolve target path %q: %v", absPath, err), Path: absPath}
		}
	} else if statErr != nil {
		return resolvedPath{}, &toolError{Code: "path_not_found", Message: fmt.Sprintf("The path %q does not exist.", absPath), Path: absPath}
	}

	if blockedPath, blocked := s.blockedSystemPath(resolved); blocked {
		return resolvedPath{}, &toolError{
			Code:    "system_path_blocked",
			Message: fmt.Sprintf("Access to %q is blocked because it resolves into the system-managed path %q.", absPath, blockedPath),
			Path:    absPath,
		}
	}

	root, ok := s.matchRootForSession(runtimeSessionID, resolved)
	if !ok {
		return resolvedPath{}, &toolError{
			Code:    "path_not_allowed",
			Message: fmt.Sprintf("The path %q is outside the directories exposed by this filesystem server.", absPath),
			Path:    absPath,
		}
	}
	if write {
		if s.cfg.ReadOnly {
			return resolvedPath{}, &toolError{
				Code:                 "read_only_mode",
				Message:              "This built-in filesystem server is currently in read-only mode. Read and search tools remain available, but write actions require manual approval in the Synapse Relay client. Ask the user to disable read-only mode there, then retry.",
				Path:                 absPath,
				RequiresUserApproval: true,
				ClientHint:           "Disable read-only mode in the Synapse Relay client, then retry the write action.",
			}
		}
		if root.Access != "rw" {
			return resolvedPath{}, &toolError{
				Code:                 "write_permission_required",
				Message:              fmt.Sprintf("The path %q is currently configured read-only in the Synapse Relay client. Ask the user to grant write access for this location, then retry.", absPath),
				Path:                 absPath,
				RequiresUserApproval: true,
				ClientHint:           "Grant write access for this location in the Synapse Relay client, then retry.",
			}
		}
	}

	if exists && info != nil && info.Mode()&os.ModeSymlink != 0 {
		return resolvedPath{}, &toolError{
			Code:    "path_not_allowed",
			Message: fmt.Sprintf("The path %q is a symbolic link and cannot be accessed directly by the filesystem server.", absPath),
			Path:    absPath,
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

func (s *Server) listAllowedDirectories(runtimeSessionID string) core.CallResult {
	entries := make([]AllowedDirectory, 0, len(s.roots))
	for _, root := range s.effectiveRootsForSession(runtimeSessionID) {
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
			"scope":       s.cfg.Scope,
			"read_only":   s.cfg.ReadOnly,
			"directories": entries,
		},
	)
}

func (s *Server) readTextFile(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Path string `json:"path"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid read_text_file arguments: %v", err)), nil
	}

	resolved, err := s.resolvePath(runtimeSessionID, input.Path, false, false)
	if err != nil {
		return toolResultError("read_text_file", "read", err), nil
	}
	info, err := os.Stat(resolved.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to stat %q: %v", resolved.Path, err)), nil
	}
	if info.IsDir() {
		return errorResult(fmt.Sprintf("%q is a directory. Use list_directory or directory_tree instead.", resolved.Path)), nil
	}
	text, parser, err := s.extractTextContent(resolved.Path, info)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to read %q: %v", resolved.Path, err)), nil
	}
	if text == "" {
		return errorResult(fmt.Sprintf("No readable text could be extracted from %q.", resolved.Path)), nil
	}
	return textResult(text, map[string]interface{}{
		"path":   resolved.Path,
		"parser": parser,
		"size":   info.Size(),
	}), nil
}

func (s *Server) getFile(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Path string `json:"path"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid get_file arguments: %v", err)), nil
	}

	resolved, err := s.resolvePath(runtimeSessionID, input.Path, false, false)
	if err != nil {
		return toolResultError("get_file", "get_file", err), nil
	}

	info, err := os.Stat(resolved.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to stat %q: %v", resolved.Path, err)), nil
	}
	if info.IsDir() {
		return errorResult(fmt.Sprintf("%q is a directory. Use list_directory or directory_tree instead.", resolved.Path)), nil
	}
	if !info.Mode().IsRegular() {
		return errorResult(fmt.Sprintf("%q is not a regular file and cannot be returned as an attachment.", resolved.Path)), nil
	}

	maxSizeBytes := s.cfg.MaxGetFileSizeBytes
	if maxSizeBytes <= 0 {
		maxSizeBytes = 20 * 1024 * 1024
	}
	if info.Size() > maxSizeBytes {
		return errorResult(fmt.Sprintf("The file %q is %d bytes, which exceeds the configured get_file limit of %d bytes.", resolved.Path, info.Size(), maxSizeBytes)), nil
	}

	data, err := os.ReadFile(resolved.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to read %q: %v", resolved.Path, err)), nil
	}
	if int64(len(data)) > maxSizeBytes {
		return errorResult(fmt.Sprintf("The file %q grew beyond the configured get_file limit of %d bytes while being read.", resolved.Path, maxSizeBytes)), nil
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
			"path":        resolved.Path,
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

func (s *Server) readMultipleFiles(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Paths []string `json:"paths"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid read_multiple_files arguments: %v", err)), nil
	}
	if len(input.Paths) == 0 {
		return errorResult("At least one path is required."), nil
	}

	parts := make([]string, 0, len(input.Paths))
	results := make([]map[string]interface{}, 0, len(input.Paths))
	for _, path := range input.Paths {
		result, err := s.readTextFile(runtimeSessionID, map[string]interface{}{"path": path})
		if err != nil {
			return result, err
		}
		if result.IsError {
			return result, nil
		}
		content, ok := result.Content[0].(core.TextContent)
		if !ok {
			continue
		}
		parts = append(parts, fmt.Sprintf("==> %s <==\n%s", path, content.Text))
		if structured, ok := result.StructuredContent.(map[string]interface{}); ok {
			results = append(results, structured)
		}
	}

	return textResult(strings.Join(parts, "\n\n"), map[string]interface{}{
		"files": results,
	}), nil
}

func (s *Server) writeFile(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid write_file arguments: %v", err)), nil
	}
	resolved, err := s.resolvePath(runtimeSessionID, input.Path, true, true)
	if err != nil {
		return toolResultError("write_file", "write", err), nil
	}
	if err := os.MkdirAll(filepath.Dir(resolved.Path), 0o755); err != nil {
		return errorResult(fmt.Sprintf("Failed to create parent directory for %q: %v", resolved.Path, err)), nil
	}
	if err := os.WriteFile(resolved.Path, []byte(input.Content), 0o644); err != nil {
		return errorResult(fmt.Sprintf("Failed to write %q: %v", resolved.Path, err)), nil
	}
	s.enqueueSync(resolved.Path, false)
	return textResult(fmt.Sprintf("Wrote %q.", resolved.Path), map[string]interface{}{"path": resolved.Path}), nil
}

func (s *Server) editFile(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Path  string `json:"path"`
		Edits []struct {
			OldText string `json:"old_text"`
			NewText string `json:"new_text"`
		} `json:"edits"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid edit_file arguments: %v", err)), nil
	}
	if len(input.Edits) == 0 {
		return errorResult("At least one edit is required."), nil
	}
	resolved, err := s.resolvePath(runtimeSessionID, input.Path, true, false)
	if err != nil {
		return toolResultError("edit_file", "edit", err), nil
	}
	data, err := os.ReadFile(resolved.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to read %q: %v", resolved.Path, err)), nil
	}
	if !looksLikeText(resolved.Path, data) {
		return errorResult(fmt.Sprintf("The file %q is not editable as plain text.", resolved.Path)), nil
	}
	content := string(data)
	for _, edit := range input.Edits {
		if !strings.Contains(content, edit.OldText) {
			return errorResult(fmt.Sprintf("The text %q was not found in %q.", edit.OldText, resolved.Path)), nil
		}
		content = strings.Replace(content, edit.OldText, edit.NewText, 1)
	}
	if err := os.WriteFile(resolved.Path, []byte(content), 0o644); err != nil {
		return errorResult(fmt.Sprintf("Failed to edit %q: %v", resolved.Path, err)), nil
	}
	s.enqueueSync(resolved.Path, false)
	return textResult(fmt.Sprintf("Edited %q.", resolved.Path), map[string]interface{}{"path": resolved.Path}), nil
}

func (s *Server) createDirectory(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Path string `json:"path"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid create_directory arguments: %v", err)), nil
	}
	resolved, err := s.resolvePath(runtimeSessionID, input.Path, true, true)
	if err != nil {
		return toolResultError("create_directory", "create_directory", err), nil
	}
	if err := os.MkdirAll(resolved.Path, 0o755); err != nil {
		return errorResult(fmt.Sprintf("Failed to create %q: %v", resolved.Path, err)), nil
	}
	s.enqueueSync(resolved.Path, true)
	return textResult(fmt.Sprintf("Created %q.", resolved.Path), map[string]interface{}{"path": resolved.Path}), nil
}

func (s *Server) listDirectory(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Path string `json:"path"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid list_directory arguments: %v", err)), nil
	}
	resolved, err := s.resolvePath(runtimeSessionID, input.Path, false, false)
	if err != nil {
		return toolResultError("list_directory", "list_directory", err), nil
	}
	entries, err := os.ReadDir(resolved.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to list %q: %v", resolved.Path, err)), nil
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	items := make([]map[string]interface{}, 0, len(entries))
	lines := make([]string, 0, len(entries))
	for _, entry := range entries {
		childPath := filepath.Join(resolved.Path, entry.Name())
		if blockedPath, blocked := s.blockedSystemPath(childPath); blocked {
			lines = append(lines, fmt.Sprintf("[blocked] %s", blockedPath))
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		item := map[string]interface{}{
			"name":        entry.Name(),
			"path":        childPath,
			"is_dir":      entry.IsDir(),
			"size_bytes":  info.Size(),
			"modified_at": info.ModTime().UTC().Format(time.RFC3339),
		}
		items = append(items, item)
		prefix := "file"
		if entry.IsDir() {
			prefix = "dir"
		}
		lines = append(lines, fmt.Sprintf("[%s] %s", prefix, childPath))
	}
	return textResult(strings.Join(lines, "\n"), map[string]interface{}{
		"path":    resolved.Path,
		"entries": items,
	}), nil
}

func (s *Server) directoryTree(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Path     string `json:"path"`
		MaxDepth int    `json:"max_depth"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid directory_tree arguments: %v", err)), nil
	}
	if input.MaxDepth <= 0 {
		input.MaxDepth = 4
	}
	resolved, err := s.resolvePath(runtimeSessionID, input.Path, false, false)
	if err != nil {
		return toolResultError("directory_tree", "directory_tree", err), nil
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

func (s *Server) moveFile(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Source      string `json:"source"`
		Destination string `json:"destination"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid move_file arguments: %v", err)), nil
	}
	source, err := s.resolvePath(runtimeSessionID, input.Source, true, false)
	if err != nil {
		return toolResultError("move_file", "move", err), nil
	}
	destination, err := s.resolvePath(runtimeSessionID, input.Destination, true, true)
	if err != nil {
		return toolResultError("move_file", "move", err), nil
	}
	if err := os.MkdirAll(filepath.Dir(destination.Path), 0o755); err != nil {
		return errorResult(fmt.Sprintf("Failed to create parent directory for %q: %v", destination.Path, err)), nil
	}
	if err := os.Rename(source.Path, destination.Path); err != nil {
		return errorResult(fmt.Sprintf("Failed to move %q to %q: %v", source.Path, destination.Path, err)), nil
	}
	s.enqueueSync(source.Path, false)
	s.enqueueSync(destination.Path, true)
	return textResult(fmt.Sprintf("Moved %q to %q.", source.Path, destination.Path), map[string]interface{}{
		"source":      source.Path,
		"destination": destination.Path,
	}), nil
}

func (s *Server) getFileInfo(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Path string `json:"path"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid get_file_info arguments: %v", err)), nil
	}
	resolved, err := s.resolvePath(runtimeSessionID, input.Path, false, false)
	if err != nil {
		return toolResultError("get_file_info", "get_file_info", err), nil
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

func (s *Server) searchFiles(_ context.Context, _ string, args map[string]interface{}) (core.CallResult, error) {
	var input SearchQuery
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid search_files arguments: %v", err)), nil
	}
	results, err := s.searchIndex(input)
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
		"query":   input.Query,
		"mode":    input.Mode,
		"results": results,
		"filters": input,
	}), nil
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
