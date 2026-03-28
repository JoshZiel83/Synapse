package filesystem

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/bmatcuk/doublestar/v4"
)

type viewedFile struct {
	Text       string
	Structured map[string]interface{}
}

type viewManyFileInput struct {
	FilePath string `json:"file_path"`
	Offset   int    `json:"offset"`
	Limit    int    `json:"limit"`
}

type patchOperationInput struct {
	FilePath  string `json:"file_path"`
	OldString string `json:"old_string"`
	NewString string `json:"new_string"`
}

type patchFileState struct {
	Path            string
	OriginalExists  bool
	CurrentExists   bool
	OriginalContent string
	CurrentContent  string
}

type structuredDataUpdateInput struct {
	FilePath string             `json:"file_path"`
	Format   string             `json:"format"`
	Updates  []structuredUpdate `json:"updates"`
}

type grepOccurrence struct {
	Line    int      `json:"line"`
	Column  int      `json:"column"`
	Match   string   `json:"match"`
	Preview string   `json:"preview"`
	Before  []string `json:"before,omitempty"`
	After   []string `json:"after,omitempty"`
}

type grepFileMatch struct {
	Path        string           `json:"path"`
	ModifiedAt  string           `json:"modified_at"`
	MatchCount  int              `json:"match_count"`
	Occurrences []grepOccurrence `json:"occurrences"`
	ModTime     int64            `json:"-"`
}

func (s *Server) readViewFile(runtimeSessionID, filePath string, offset, limit int) (viewedFile, error) {
	if err := requireAbsolutePath("file_path", filePath); err != nil {
		return viewedFile{}, err
	}

	resolved, err := s.resolvePath(runtimeSessionID, filePath, false, false)
	if err != nil {
		return viewedFile{}, err
	}
	info, err := os.Stat(resolved.Path)
	if err != nil {
		return viewedFile{}, fmt.Errorf("Failed to stat %q: %v", resolved.Path, err)
	}
	if info.IsDir() {
		return viewedFile{}, fmt.Errorf("%q is a directory. Use LS or DirectoryTree instead.", resolved.Path)
	}

	text, parser, err := s.extractTextContent(resolved.Path, info)
	if err != nil {
		return viewedFile{}, fmt.Errorf("Failed to read %q: %v", resolved.Path, err)
	}
	if text == "" {
		return viewedFile{}, fmt.Errorf("No readable text could be extracted from %q. Use GetFile for a full file download instead.", resolved.Path)
	}

	content, totalLines, returnedLines, truncatedAny := sliceTextByLine(text, offset, limit)
	return viewedFile{
		Text: content,
		Structured: map[string]interface{}{
			"file_path":       resolved.Path,
			"parser":          parser,
			"offset":          offset,
			"returned_lines":  returnedLines,
			"total_lines":     totalLines,
			"truncated_lines": truncatedAny,
			"size_bytes":      info.Size(),
			"root_id":         resolved.Root.ID,
			"access":          resolved.Root.Access,
		},
	}, nil
}

func (s *Server) captureBackup(path, operation string) (backupResult, error) {
	cleanPath := filepath.Clean(path)
	if s.backups == nil {
		return backupResult{
			Status:     "disabled",
			Path:       cleanPath,
			Operation:  operation,
			Reason:     "Automatic backups are not configured.",
			Restorable: false,
		}, nil
	}
	return s.backups.capture(cleanPath, operation)
}

func (s *Server) captureBackups(paths []string, operation string) ([]backupResult, error) {
	normalized := uniqueCleanPaths(paths)
	backups := make([]backupResult, 0, len(normalized))
	for _, path := range normalized {
		backup, err := s.captureBackup(path, operation)
		if err != nil {
			return nil, err
		}
		backups = append(backups, backup)
	}
	return backups, nil
}

func errorResultWithStructured(text string, structured map[string]interface{}) core.CallResult {
	return core.CallResult{
		Content:           []interface{}{core.Text(text)},
		StructuredContent: structured,
		IsError:           true,
	}
}

func errorResultWithBackups(text string, structured map[string]interface{}, backups []backupResult) core.CallResult {
	return errorResultWithStructured(text, attachBackupResults(structured, backups))
}

func loadEditableTextFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if !looksLikeText(path, data) {
		return "", fmt.Errorf("The file %q is not editable as plain text.", path)
	}
	return string(data), nil
}

func (s *Server) viewMany(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Files []viewManyFileInput `json:"files"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid ViewMany arguments: %v", err)), nil
	}
	if len(input.Files) == 0 {
		return errorResult("files must contain at least one item."), nil
	}

	sections := make([]string, 0, len(input.Files))
	items := make([]map[string]interface{}, 0, len(input.Files))
	for _, file := range input.Files {
		viewed, err := s.readViewFile(runtimeSessionID, file.FilePath, file.Offset, file.Limit)
		if err != nil {
			if toolErr, ok := err.(*toolError); ok {
				return toolErr.result("ViewMany", "read"), nil
			}
			return errorResult(err.Error()), nil
		}
		pathValue, _ := viewed.Structured["file_path"].(string)
		sections = append(sections, fmt.Sprintf("== %s ==\n%s", pathValue, viewed.Text))
		item := make(map[string]interface{}, len(viewed.Structured)+1)
		for key, value := range viewed.Structured {
			item[key] = value
		}
		item["content"] = viewed.Text
		items = append(items, item)
	}

	return textResult(strings.Join(sections, "\n\n"), map[string]interface{}{
		"files": items,
		"count": len(items),
	}), nil
}

func (s *Server) patchTool(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Operations []patchOperationInput `json:"operations"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid Patch arguments: %v", err)), nil
	}
	if len(input.Operations) == 0 {
		return errorResult("operations must contain at least one item."), nil
	}

	type resolvedPatchOperation struct {
		Path           string
		OriginalExists bool
		OldString      string
		NewString      string
	}

	resolvedOps := make([]resolvedPatchOperation, 0, len(input.Operations))
	resolvedPaths := make([]string, 0, len(input.Operations))
	for _, operation := range input.Operations {
		if err := requireAbsolutePath("file_path", operation.FilePath); err != nil {
			return toolResultError("Patch", "write", err), nil
		}
		resolved, err := s.resolvePath(runtimeSessionID, operation.FilePath, true, true)
		if err != nil {
			return toolResultError("Patch", "write", err), nil
		}
		resolvedOps = append(resolvedOps, resolvedPatchOperation{
			Path:           resolved.Path,
			OriginalExists: resolved.Exists,
			OldString:      operation.OldString,
			NewString:      operation.NewString,
		})
		resolvedPaths = append(resolvedPaths, resolved.Path)
	}

	unlock := s.lockPaths(resolvedPaths)
	defer unlock()

	states := make(map[string]*patchFileState, len(input.Operations))
	order := make([]string, 0, len(input.Operations))
	for index, operation := range resolvedOps {
		state, exists := states[operation.Path]
		if !exists {
			state = &patchFileState{Path: operation.Path, OriginalExists: operation.OriginalExists}
			if operation.OriginalExists {
				info, err := os.Stat(operation.Path)
				if err != nil {
					return errorResult(fmt.Sprintf("Failed to stat %q: %v", operation.Path, err)), nil
				}
				if info.IsDir() {
					return errorResult(fmt.Sprintf("%q is a directory.", operation.Path)), nil
				}
				content, err := loadEditableTextFile(operation.Path)
				if err != nil {
					return errorResult(err.Error()), nil
				}
				state.OriginalContent = content
				state.CurrentContent = content
				state.CurrentExists = true
			}
			states[operation.Path] = state
			order = append(order, operation.Path)
		}

		if !state.CurrentExists && operation.OldString == "" {
			state.CurrentContent = operation.NewString
			state.CurrentExists = true
			continue
		}
		if !state.CurrentExists && operation.OldString != "" {
			return errorResult(fmt.Sprintf("Patch operation %d targets %q, which does not exist yet. Use an empty old_string only when creating a brand new file.", index, operation.Path)), nil
		}
		if operation.OldString == "" {
			return errorResult(fmt.Sprintf("Patch operation %d targets %q and old_string must not be empty for an existing file.", index, operation.Path)), nil
		}

		matches := strings.Count(state.CurrentContent, operation.OldString)
		switch {
		case matches == 0:
			return errorResult(fmt.Sprintf("Patch operation %d could not find old_string in %q.", index, operation.Path)), nil
		case matches > 1:
			return errorResult(fmt.Sprintf("Patch operation %d matched %d locations in %q. Provide more surrounding context so the replacement is unique.", index, matches, operation.Path)), nil
		}
		state.CurrentContent = strings.Replace(state.CurrentContent, operation.OldString, operation.NewString, 1)
	}

	changedPaths := make([]string, 0, len(order))
	files := make([]map[string]interface{}, 0, len(order))
	for _, path := range order {
		state := states[path]
		changed := (!state.OriginalExists && state.CurrentExists) || state.CurrentContent != state.OriginalContent
		if changed {
			changedPaths = append(changedPaths, path)
		}
		files = append(files, map[string]interface{}{
			"file_path": path,
			"created":   !state.OriginalExists,
			"changed":   changed,
		})
	}
	if len(changedPaths) == 0 {
		return textResult("Patch validated successfully but produced no file changes.", map[string]interface{}{
			"files":           files,
			"operation_count": len(input.Operations),
			"changed_files":   0,
		}), nil
	}

	backups, err := s.captureBackups(changedPaths, "patch")
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to prepare backups for Patch: %v", err)), nil
	}

	applied := make([]string, 0, len(changedPaths))
	for _, path := range order {
		state := states[path]
		if state.OriginalExists && state.CurrentContent == state.OriginalContent {
			continue
		}
		if !state.OriginalExists && !state.CurrentExists {
			continue
		}
		if err := writeTextFile(path, state.CurrentContent); err != nil {
			rollbackPatchWrites(states, applied)
			return errorResultWithBackups(fmt.Sprintf("Failed to apply Patch to %q: %v", path, err), map[string]interface{}{
				"failed_path": path,
			}, backups), nil
		}
		applied = append(applied, path)
	}

	for _, path := range changedPaths {
		s.syncAfterMutation(path, false)
	}
	return textResultWithBackups(fmt.Sprintf("Patched %d file(s) with %d operation(s).", len(changedPaths), len(input.Operations)), map[string]interface{}{
		"files":           files,
		"operation_count": len(input.Operations),
		"changed_files":   len(changedPaths),
	}, backups), nil
}

func rollbackPatchWrites(states map[string]*patchFileState, applied []string) {
	for index := len(applied) - 1; index >= 0; index-- {
		path := applied[index]
		state := states[path]
		if state == nil {
			continue
		}
		if state.OriginalExists {
			_ = writeTextFile(path, state.OriginalContent)
			continue
		}
		_ = os.Remove(path)
	}
}

func (s *Server) updateStructuredData(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input structuredDataUpdateInput
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid UpdateStructuredData arguments: %v", err)), nil
	}
	if err := requireAbsolutePath("file_path", input.FilePath); err != nil {
		return toolResultError("UpdateStructuredData", "write", err), nil
	}
	if len(input.Updates) == 0 {
		return errorResult("updates must contain at least one item."), nil
	}

	resolved, err := s.resolvePath(runtimeSessionID, input.FilePath, true, true)
	if err != nil {
		return toolResultError("UpdateStructuredData", "write", err), nil
	}
	unlock := s.lockPaths([]string{resolved.Path})
	defer unlock()

	var (
		document interface{}
		format   structuredFormat
	)
	if resolved.Exists {
		info, err := os.Stat(resolved.Path)
		if err != nil {
			return errorResult(fmt.Sprintf("Failed to stat %q: %v", resolved.Path, err)), nil
		}
		if info.IsDir() {
			return errorResult(fmt.Sprintf("%q is a directory.", resolved.Path)), nil
		}
		data, err := os.ReadFile(resolved.Path)
		if err != nil {
			return errorResult(fmt.Sprintf("Failed to read %q: %v", resolved.Path, err)), nil
		}
		document, format, err = parseStructuredDocument(resolved.Path, input.Format, data)
		if err != nil {
			return errorResult(fmt.Sprintf("Failed to parse %q: %v", resolved.Path, err)), nil
		}
	} else {
		format, err = inferStructuredFormat(resolved.Path, input.Format)
		if err != nil {
			return errorResult(err.Error()), nil
		}
	}

	updated, err := applyStructuredUpdates(document, input.Updates)
	if err != nil {
		return errorResult(fmt.Sprintf("UpdateStructuredData failed for %q: %v", resolved.Path, err)), nil
	}
	content, err := marshalStructuredDocument(updated, format)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to serialize %q: %v", resolved.Path, err)), nil
	}

	backups, err := s.captureBackups([]string{resolved.Path}, "update_structured_data")
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to prepare backups for UpdateStructuredData: %v", err)), nil
	}
	if err := writeTextFile(resolved.Path, string(content)); err != nil {
		return errorResultWithBackups(fmt.Sprintf("Failed to write %q: %v", resolved.Path, err), map[string]interface{}{
			"file_path": resolved.Path,
			"format":    string(format),
		}, backups), nil
	}
	s.syncAfterMutation(resolved.Path, false)
	return textResultWithBackups(fmt.Sprintf("Updated structured data in %q.", resolved.Path), map[string]interface{}{
		"file_path": resolved.Path,
		"format":    string(format),
		"updates":   len(input.Updates),
	}, backups), nil
}

func (s *Server) copyPath(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		SourcePath      string `json:"source_path"`
		DestinationPath string `json:"destination_path"`
		Recursive       bool   `json:"recursive"`
		Overwrite       bool   `json:"overwrite"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid Copy arguments: %v", err)), nil
	}
	if err := requireAbsolutePath("source_path", input.SourcePath); err != nil {
		return toolResultError("Copy", "read", err), nil
	}
	if err := requireAbsolutePath("destination_path", input.DestinationPath); err != nil {
		return toolResultError("Copy", "write", err), nil
	}

	source, err := s.resolvePath(runtimeSessionID, input.SourcePath, false, false)
	if err != nil {
		return toolResultError("Copy", "read", err), nil
	}
	destination, err := s.resolvePath(runtimeSessionID, input.DestinationPath, true, true)
	if err != nil {
		return toolResultError("Copy", "write", err), nil
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
	if sourceInfo.IsDir() && !input.Recursive {
		return errorResult("recursive must be true when copying a directory."), nil
	}
	if sourceInfo.IsDir() && pathWithinPrefix(normalizePathForMatch(destination.Path), normalizePathForMatch(source.Path)) {
		return errorResult("destination_path cannot be inside source_path when copying a directory."), nil
	}
	if destination.Exists && !input.Overwrite {
		return errorResult(fmt.Sprintf("The destination %q already exists. Set overwrite to true to replace it.", destination.Path)), nil
	}

	backups, err := s.captureBackups([]string{destination.Path}, "copy")
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to prepare backups for Copy: %v", err)), nil
	}
	if destination.Exists {
		if err := os.RemoveAll(destination.Path); err != nil {
			return errorResultWithBackups(fmt.Sprintf("Failed to replace %q: %v", destination.Path, err), map[string]interface{}{
				"destination_path": destination.Path,
			}, backups), nil
		}
	}
	if err := os.MkdirAll(filepath.Dir(destination.Path), 0o755); err != nil {
		return errorResultWithBackups(fmt.Sprintf("Failed to prepare parent directory for %q: %v", destination.Path, err), map[string]interface{}{
			"destination_path": destination.Path,
		}, backups), nil
	}
	if err := copyFilesystemPath(source.Path, destination.Path, sourceInfo); err != nil {
		return errorResultWithBackups(fmt.Sprintf("Failed to copy %q to %q: %v", source.Path, destination.Path, err), map[string]interface{}{
			"source_path":      source.Path,
			"destination_path": destination.Path,
		}, backups), nil
	}

	s.syncAfterMutation(destination.Path, sourceInfo.IsDir())
	return textResultWithBackups(fmt.Sprintf("Copied %q to %q.", source.Path, destination.Path), map[string]interface{}{
		"source_path":      source.Path,
		"destination_path": destination.Path,
		"recursive":        sourceInfo.IsDir(),
		"overwrote":        destination.Exists,
	}, backups), nil
}

func copyFilesystemPath(source, destination string, info os.FileInfo) error {
	if info.IsDir() {
		return filepath.WalkDir(source, func(current string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("refusing to copy symbolic link %q", current)
			}
			rel, err := filepath.Rel(source, current)
			if err != nil {
				return err
			}
			target := destination
			if rel != "." {
				target = filepath.Join(destination, rel)
			}
			if entry.IsDir() {
				info, err := entry.Info()
				if err != nil {
					return err
				}
				return os.MkdirAll(target, info.Mode().Perm())
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			return copyRegularFile(current, target, info.Mode().Perm())
		})
	}
	return copyRegularFile(source, destination, info.Mode().Perm())
}

func copyRegularFile(source, destination string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	sourceHandle, err := os.Open(source)
	if err != nil {
		return err
	}
	defer sourceHandle.Close()

	destinationHandle, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer destinationHandle.Close()

	if _, err := io.Copy(destinationHandle, sourceHandle); err != nil {
		return err
	}
	return nil
}

func (s *Server) deletePath(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid Delete arguments: %v", err)), nil
	}
	if err := requireAbsolutePath("path", input.Path); err != nil {
		return toolResultError("Delete", "write", err), nil
	}

	resolved, err := s.resolvePath(runtimeSessionID, input.Path, true, false)
	if err != nil {
		return toolResultError("Delete", "write", err), nil
	}
	unlock := s.lockPaths([]string{resolved.Path})
	defer unlock()
	info, err := os.Stat(resolved.Path)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to stat %q: %v", resolved.Path, err)), nil
	}
	if info.IsDir() && !input.Recursive {
		return errorResult("recursive must be true when deleting a directory."), nil
	}

	backups, err := s.captureBackups([]string{resolved.Path}, "delete")
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to prepare backups for Delete: %v", err)), nil
	}
	if info.IsDir() {
		if err := os.RemoveAll(resolved.Path); err != nil {
			return errorResultWithBackups(fmt.Sprintf("Failed to delete %q: %v", resolved.Path, err), map[string]interface{}{
				"path": resolved.Path,
			}, backups), nil
		}
	} else {
		if err := os.Remove(resolved.Path); err != nil {
			return errorResultWithBackups(fmt.Sprintf("Failed to delete %q: %v", resolved.Path, err), map[string]interface{}{
				"path": resolved.Path,
			}, backups), nil
		}
	}

	s.syncAfterMutation(resolved.Path, info.IsDir())
	return textResultWithBackups(fmt.Sprintf("Deleted %q.", resolved.Path), map[string]interface{}{
		"path":      resolved.Path,
		"recursive": info.IsDir(),
	}, backups), nil
}

func (s *Server) listBackups(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		Path      string `json:"path"`
		Operation string `json:"operation"`
		Offset    int    `json:"offset"`
		Limit     int    `json:"limit"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid ListBackups arguments: %v", err)), nil
	}
	if s.backups == nil {
		return errorResult("Automatic backups are not configured for this filesystem server."), nil
	}
	if input.Limit <= 0 {
		input.Limit = 50
	}
	if input.Limit > 500 {
		input.Limit = 500
	}
	if input.Offset < 0 {
		return errorResult("offset must be greater than or equal to 0."), nil
	}

	filterPath := ""
	if strings.TrimSpace(input.Path) != "" {
		if err := requireAbsolutePath("path", input.Path); err != nil {
			return toolResultError("ListBackups", "read", err), nil
		}
		resolved, err := s.resolvePath(runtimeSessionID, input.Path, false, true)
		if err != nil {
			return toolResultError("ListBackups", "read", err), nil
		}
		filterPath = resolved.Path
	}

	listing, err := s.backups.list(filterPath, input.Operation)
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to list backups: %v", err)), nil
	}

	visible := make([]backupRecord, 0, len(listing.Records))
	for _, record := range listing.Records {
		if filterPath == "" {
			if _, err := s.resolvePath(runtimeSessionID, record.OriginalPath, false, true); err != nil {
				continue
			}
		}
		visible = append(visible, record)
	}

	start := input.Offset
	if start > len(visible) {
		start = len(visible)
	}
	end := start + input.Limit
	if end > len(visible) {
		end = len(visible)
	}
	paged := visible[start:end]

	lines := make([]string, 0, len(paged))
	items := make([]map[string]interface{}, 0, len(paged))
	for _, record := range paged {
		lines = append(lines, fmt.Sprintf("%s %s %s %s", record.ID, record.CreatedAt, record.Operation, record.OriginalPath))
		items = append(items, map[string]interface{}{
			"backup_id":      record.ID,
			"path":           record.OriginalPath,
			"kind":           record.OriginalKind,
			"operation":      record.Operation,
			"created_at":     record.CreatedAt,
			"size_bytes":     record.SizeBytes,
			"mime_type":      record.MimeType,
			"encoding":       record.Encoding,
			"restorable":     true,
			"sha256":         record.SHA256,
			"backup_blob_id": record.BlobFile,
		})
	}

	return textResult(strings.Join(lines, "\n"), map[string]interface{}{
		"backups":      items,
		"total":        len(visible),
		"offset":       start,
		"limit":        input.Limit,
		"has_more":     end < len(visible),
		"path":         filterPath,
		"operation":    strings.TrimSpace(input.Operation),
		"used_bytes":   listing.UsedBytes,
		"limit_bytes":  listing.LimitBytes,
		"pruned_count": listing.PrunedCount,
	}), nil
}

func (s *Server) getBackup(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		BackupID string `json:"backup_id"`
		Path     string `json:"path"`
		Offset   int    `json:"offset"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid GetBackup arguments: %v", err)), nil
	}
	if s.backups == nil {
		return errorResult("Automatic backups are not configured for this filesystem server."), nil
	}

	hasBackupID := strings.TrimSpace(input.BackupID) != ""
	hasPath := strings.TrimSpace(input.Path) != ""
	if hasBackupID == hasPath {
		return errorResult("Provide exactly one of backup_id or path."), nil
	}

	var (
		payload backupPayload
		err     error
	)
	if hasBackupID {
		payload, err = s.backups.getByID(strings.TrimSpace(input.BackupID))
		if err != nil {
			if os.IsNotExist(err) {
				return errorResult(fmt.Sprintf("Backup %q was not found.", strings.TrimSpace(input.BackupID))), nil
			}
			return errorResult(fmt.Sprintf("Failed to load backup %q: %v", strings.TrimSpace(input.BackupID), err)), nil
		}
		if _, resolveErr := s.resolvePath(runtimeSessionID, payload.Record.OriginalPath, false, true); resolveErr != nil {
			return toolResultError("GetBackup", "read", resolveErr), nil
		}
	} else {
		if err := requireAbsolutePath("path", input.Path); err != nil {
			return toolResultError("GetBackup", "read", err), nil
		}
		resolved, resolveErr := s.resolvePath(runtimeSessionID, input.Path, false, true)
		if resolveErr != nil {
			return toolResultError("GetBackup", "read", resolveErr), nil
		}
		payload, err = s.backups.getByPath(resolved.Path, input.Offset)
		if err != nil {
			if os.IsNotExist(err) {
				return errorResult(fmt.Sprintf("No backup was found for %q at offset %d.", resolved.Path, input.Offset)), nil
			}
			return errorResult(fmt.Sprintf("Failed to load backup history for %q: %v", resolved.Path, err)), nil
		}
	}

	return backupPayloadResult(payload), nil
}

func (s *Server) restoreBackup(runtimeSessionID string, args map[string]interface{}) (core.CallResult, error) {
	var input struct {
		BackupID   string `json:"backup_id"`
		TargetPath string `json:"target_path"`
	}
	if err := decodeArgs(args, &input); err != nil {
		return errorResult(fmt.Sprintf("Invalid RestoreBackup arguments: %v", err)), nil
	}
	if s.backups == nil {
		return errorResult("Automatic backups are not configured for this filesystem server."), nil
	}
	if strings.TrimSpace(input.BackupID) == "" {
		return errorResult("backup_id is required."), nil
	}

	payload, err := s.backups.getByID(strings.TrimSpace(input.BackupID))
	if err != nil {
		if os.IsNotExist(err) {
			return errorResult(fmt.Sprintf("Backup %q was not found.", strings.TrimSpace(input.BackupID))), nil
		}
		return errorResult(fmt.Sprintf("Failed to load backup %q: %v", strings.TrimSpace(input.BackupID), err)), nil
	}
	if _, resolveErr := s.resolvePath(runtimeSessionID, payload.Record.OriginalPath, false, true); resolveErr != nil {
		return toolResultError("RestoreBackup", "read", resolveErr), nil
	}

	targetPath := payload.Record.OriginalPath
	if strings.TrimSpace(input.TargetPath) != "" {
		targetPath = strings.TrimSpace(input.TargetPath)
		if err := requireAbsolutePath("target_path", targetPath); err != nil {
			return toolResultError("RestoreBackup", "write", err), nil
		}
	}
	target, err := s.resolvePath(runtimeSessionID, targetPath, true, true)
	if err != nil {
		return toolResultError("RestoreBackup", "write", err), nil
	}
	unlock := s.lockPaths([]string{target.Path})
	defer unlock()

	backups, err := s.captureBackups([]string{target.Path}, "restore")
	if err != nil {
		return errorResult(fmt.Sprintf("Failed to prepare backups for RestoreBackup: %v", err)), nil
	}
	if err := s.backups.restore(payload, target.Path); err != nil {
		return errorResultWithBackups(fmt.Sprintf("Failed to restore backup %q to %q: %v", payload.Record.ID, target.Path, err), map[string]interface{}{
			"backup_id":   payload.Record.ID,
			"target_path": target.Path,
		}, backups), nil
	}

	s.syncAfterMutation(target.Path, payload.Record.OriginalKind == "directory")
	return textResultWithBackups(fmt.Sprintf("Restored backup %q to %q.", payload.Record.ID, target.Path), map[string]interface{}{
		"backup_id":     payload.Record.ID,
		"original_path": payload.Record.OriginalPath,
		"target_path":   target.Path,
		"kind":          payload.Record.OriginalKind,
	}, backups), nil
}

func sortGrepFileMatches(matches []grepFileMatch) {
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].ModTime != matches[j].ModTime {
			return matches[i].ModTime > matches[j].ModTime
		}
		return matches[i].Path < matches[j].Path
	})
}

func grepMatchResult(pattern, root string, matches []grepFileMatch, maxMatches int, truncated bool) core.CallResult {
	lines := make([]string, 0)
	totalMatches := 0
	structuredMatches := make([]map[string]interface{}, 0, len(matches))
	for _, match := range matches {
		totalMatches += len(match.Occurrences)
		occurrences := make([]map[string]interface{}, 0, len(match.Occurrences))
		for _, occurrence := range match.Occurrences {
			lines = append(lines, fmt.Sprintf("%s:%d:%d: %s", match.Path, occurrence.Line, occurrence.Column, occurrence.Preview))
			occurrenceMap := map[string]interface{}{
				"line":    occurrence.Line,
				"column":  occurrence.Column,
				"match":   occurrence.Match,
				"preview": occurrence.Preview,
			}
			if len(occurrence.Before) > 0 {
				occurrenceMap["before"] = occurrence.Before
			}
			if len(occurrence.After) > 0 {
				occurrenceMap["after"] = occurrence.After
			}
			occurrences = append(occurrences, occurrenceMap)
		}
		structuredMatches = append(structuredMatches, map[string]interface{}{
			"path":        match.Path,
			"modified_at": match.ModifiedAt,
			"match_count": match.MatchCount,
			"occurrences": occurrences,
		})
	}
	return textResult(strings.Join(lines, "\n"), map[string]interface{}{
		"pattern":          pattern,
		"path":             root,
		"matches":          structuredMatches,
		"returned_matches": totalMatches,
		"max_matches":      maxMatches,
		"truncated":        truncated,
	})
}

func (s *Server) grepMatchesDetailed(root string, rootInfo os.FileInfo, re *regexp.Regexp, include string, pathFilter *pathSearchFilter, maxMatches, contextBefore, contextAfter int) ([]grepFileMatch, bool, error) {
	include = strings.TrimSpace(include)
	matches := make([]grepFileMatch, 0)
	totalMatches := 0
	truncated := false

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
		if pathFilter != nil && pathFilter.Skip(path, info.IsDir()) {
			return nil
		}
		allowed, err := matchInclude(rel)
		if err != nil || !allowed {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		text, ok := decodeExtractableText(path, data)
		if !ok {
			return nil
		}
		normalized := strings.ReplaceAll(text, "\r\n", "\n")
		indexes := re.FindAllStringIndex(normalized, -1)
		if len(indexes) == 0 {
			return nil
		}

		lines, lineOffsets := splitLinesWithOffsets(normalized)
		fileMatch := grepFileMatch{
			Path:       path,
			ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
			ModTime:    info.ModTime().UnixNano(),
		}
		for _, location := range indexes {
			if totalMatches >= maxMatches {
				truncated = true
				break
			}
			lineIndex := lineIndexForOffset(lineOffsets, location[0])
			preview, _ := truncateLine(lines[lineIndex], 400)
			matchText, _ := truncateLine(normalized[location[0]:location[1]], 400)
			occurrence := grepOccurrence{
				Line:    lineIndex + 1,
				Column:  columnForOffset(lines[lineIndex], location[0]-lineOffsets[lineIndex]),
				Match:   matchText,
				Preview: preview,
				Before:  contextWindow(lines, lineIndex-contextBefore, lineIndex),
				After:   contextWindow(lines, lineIndex+1, lineIndex+1+contextAfter),
			}
			fileMatch.Occurrences = append(fileMatch.Occurrences, occurrence)
			totalMatches++
		}
		fileMatch.MatchCount = len(fileMatch.Occurrences)
		if fileMatch.MatchCount > 0 {
			matches = append(matches, fileMatch)
		}
		return nil
	}

	if !rootInfo.IsDir() {
		if err := searchFile(root, rootInfo, filepath.Base(root)); err != nil {
			return nil, false, err
		}
		return matches, truncated, nil
	}

	err := filepath.WalkDir(root, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if truncated {
			return fs.SkipAll
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
	if err == fs.SkipAll {
		err = nil
	}
	return matches, truncated, err
}

func splitLinesWithOffsets(text string) ([]string, []int) {
	lines := strings.Split(text, "\n")
	offsets := make([]int, len(lines))
	offset := 0
	for index, line := range lines {
		offsets[index] = offset
		offset += len(line) + 1
	}
	return lines, offsets
}

func lineIndexForOffset(offsets []int, offset int) int {
	index := sort.Search(len(offsets), func(position int) bool {
		return offsets[position] > offset
	}) - 1
	if index < 0 {
		return 0
	}
	if index >= len(offsets) {
		return len(offsets) - 1
	}
	return index
}

func columnForOffset(line string, offset int) int {
	if offset < 0 {
		offset = 0
	}
	if offset > len(line) {
		offset = len(line)
	}
	return utf8.RuneCountInString(line[:offset]) + 1
}

func contextWindow(lines []string, start, end int) []string {
	if start < 0 {
		start = 0
	}
	if end > len(lines) {
		end = len(lines)
	}
	if start >= end {
		return nil
	}
	window := make([]string, 0, end-start)
	for _, line := range lines[start:end] {
		truncated, _ := truncateLine(line, 400)
		window = append(window, truncated)
	}
	return window
}
