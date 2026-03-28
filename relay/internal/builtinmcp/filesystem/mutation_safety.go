package filesystem

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

func uniqueCleanPaths(paths []string) []string {
	seen := make(map[string]struct{}, len(paths))
	unique := make([]string, 0, len(paths))
	for _, path := range paths {
		cleanPath := filepath.Clean(strings.TrimSpace(path))
		if cleanPath == "" || cleanPath == "." {
			continue
		}
		if _, exists := seen[cleanPath]; exists {
			continue
		}
		seen[cleanPath] = struct{}{}
		unique = append(unique, cleanPath)
	}
	sort.Strings(unique)
	return unique
}

func (s *Server) lockPaths(paths []string) func() {
	normalized := uniqueCleanPaths(paths)
	if len(normalized) == 0 {
		return func() {}
	}

	locks := make([]*sync.Mutex, 0, len(normalized))
	s.pathLockMu.Lock()
	for _, path := range normalized {
		lock, exists := s.pathLocks[path]
		if !exists {
			lock = &sync.Mutex{}
			s.pathLocks[path] = lock
		}
		locks = append(locks, lock)
	}
	s.pathLockMu.Unlock()

	for _, lock := range locks {
		lock.Lock()
	}
	return func() {
		for index := len(locks) - 1; index >= 0; index-- {
			locks[index].Unlock()
		}
	}
}

func preferredLineEnding(data []byte) string {
	if len(data) == 0 {
		return ""
	}
	crlfCount := bytes.Count(data, []byte("\r\n"))
	lfCount := bytes.Count(data, []byte("\n"))
	if crlfCount > 0 && crlfCount == lfCount {
		return "\r\n"
	}
	return ""
}

func applyPreferredLineEnding(content, lineEnding string) string {
	if lineEnding != "\r\n" {
		return content
	}
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	return strings.ReplaceAll(normalized, "\n", "\r\n")
}

func existingWriteModeAndLineEnding(path string) (os.FileMode, string, error) {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0o644, "", nil
		}
		return 0, "", err
	}

	lineEnding := ""
	if !info.IsDir() {
		if data, readErr := os.ReadFile(path); readErr == nil {
			lineEnding = preferredLineEnding(data)
		}
	}
	return info.Mode().Perm(), lineEnding, nil
}

func writeTextFile(path, content string) error {
	mode, lineEnding, err := existingWriteModeAndLineEnding(path)
	if err != nil {
		return err
	}
	if err := ensureParentDirectory(path); err != nil {
		return err
	}

	content = applyPreferredLineEnding(content, lineEnding)
	tempFile, err := os.CreateTemp(filepath.Dir(path), ".synapse-write-*")
	if err != nil {
		return err
	}
	tempPath := tempFile.Name()
	cleanup := func() {
		_ = os.Remove(tempPath)
	}
	if err := tempFile.Chmod(mode); err != nil {
		tempFile.Close()
		cleanup()
		return err
	}
	if _, err := tempFile.WriteString(content); err != nil {
		tempFile.Close()
		cleanup()
		return err
	}
	if err := tempFile.Sync(); err != nil {
		tempFile.Close()
		cleanup()
		return err
	}
	if err := tempFile.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		cleanup()
		return err
	}
	return nil
}
