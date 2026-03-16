package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSuggestedFilesystemRootsFromUserDirsUsesExistingDirectories(t *testing.T) {
	dir := t.TempDir()
	downloadDir := filepath.Join(dir, "Downloads")
	desktopDir := filepath.Join(dir, "Desktop")
	if err := os.MkdirAll(downloadDir, 0o755); err != nil {
		t.Fatalf("create download dir: %v", err)
	}
	if err := os.MkdirAll(desktopDir, 0o755); err != nil {
		t.Fatalf("create desktop dir: %v", err)
	}

	roots := suggestedFilesystemRootsFromUserDirs(downloadDir, desktopDir)
	if len(roots) != 2 {
		t.Fatalf("expected 2 roots, got %d: %+v", len(roots), roots)
	}
	if roots[0].Path != downloadDir || roots[0].Access != "ro" {
		t.Fatalf("expected first root to be download dir, got %+v", roots[0])
	}
	if roots[1].Path != desktopDir || roots[1].Access != "ro" {
		t.Fatalf("expected second root to be desktop dir, got %+v", roots[1])
	}
}

func TestSuggestedFilesystemRootsFromUserDirsSkipsMissingDuplicateAndFilePaths(t *testing.T) {
	dir := t.TempDir()
	downloadDir := filepath.Join(dir, "Downloads")
	if err := os.MkdirAll(downloadDir, 0o755); err != nil {
		t.Fatalf("create download dir: %v", err)
	}
	filePath := filepath.Join(dir, "Desktop.txt")
	if err := os.WriteFile(filePath, []byte("test"), 0o644); err != nil {
		t.Fatalf("create desktop file: %v", err)
	}

	roots := suggestedFilesystemRootsFromUserDirs(downloadDir, downloadDir)
	if len(roots) != 1 {
		t.Fatalf("expected 1 root after dedupe, got %d: %+v", len(roots), roots)
	}
	if roots[0].Path != downloadDir {
		t.Fatalf("expected deduped root to be download dir, got %+v", roots[0])
	}

	roots = suggestedFilesystemRootsFromUserDirs("", filePath)
	if len(roots) != 0 {
		t.Fatalf("expected file path to be ignored, got %+v", roots)
	}
}
