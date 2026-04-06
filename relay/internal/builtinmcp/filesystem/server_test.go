package filesystem

import (
	"archive/zip"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
)

func newTestServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	cfg.Enabled = true

	server, err := New(cfg)
	if err != nil {
		t.Fatalf("new filesystem server: %v", err)
	}
	if err := server.Start(context.Background()); err != nil {
		t.Fatalf("start filesystem server: %v", err)
	}
	t.Cleanup(server.Shutdown)
	return server
}

func newIndexOnlyTestServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	cfg.Enabled = true

	server, err := New(cfg)
	if err != nil {
		t.Fatalf("new filesystem server: %v", err)
	}
	if err := server.openIndex(); err != nil {
		t.Fatalf("open filesystem index: %v", err)
	}
	t.Cleanup(server.closeIndex)
	return server
}

func TestListToolsExposesOnlyNormalizedFilesystemTools(t *testing.T) {
	server, err := New(Config{
		StableKey: "test-tool-catalog",
		Name:      "filesystem",
		Enabled:   true,
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: t.TempDir(), Access: "rw"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})
	if err != nil {
		t.Fatalf("new filesystem server: %v", err)
	}

	tools, err := server.ListTools()
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}

	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool.Name)
	}

	expected := []string{
		"ListAllowedDirectories",
		"View",
		"ViewMany",
		"GetFile",
		"Replace",
		"Edit",
		"Patch",
		"UpdateStructuredData",
		"CreateDirectory",
		"LS",
		"DirectoryTree",
		"Move",
		"Copy",
		"Delete",
		"Stat",
		"GlobTool",
		"GrepTool",
		"SearchFiles",
		"ListBackups",
		"GetBackup",
		"RestoreBackup",
	}
	if len(names) != len(expected) {
		t.Fatalf("unexpected tool count %d: %v", len(names), names)
	}
	for index, name := range expected {
		if names[index] != name {
			t.Fatalf("unexpected tool at %d: got %q want %q", index, names[index], name)
		}
	}

	descriptions := make(map[string]string, len(tools))
	for _, tool := range tools {
		descriptions[tool.Name] = tool.Description
	}
	if !strings.Contains(descriptions["View"], "parsed PDFs") {
		t.Fatalf("expected View description to mention extracted rich document support, got %q", descriptions["View"])
	}
	if !strings.Contains(descriptions["GetFile"], "original file bytes") {
		t.Fatalf("expected GetFile description to explain raw-byte usage, got %q", descriptions["GetFile"])
	}
	if strings.Contains(descriptions["GlobTool"], "Agent tool") || strings.Contains(descriptions["GrepTool"], "Agent tool") {
		t.Fatalf("filesystem tool descriptions should not reference a nonexistent Agent tool: Glob=%q Grep=%q", descriptions["GlobTool"], descriptions["GrepTool"])
	}
}

func TestReadOnlyModeBlocksWriteTool(t *testing.T) {
	root := t.TempDir()
	server := newTestServer(t, Config{
		StableKey: "test-readonly",
		Name:      "filesystem",
		ReadOnly:  true,
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "rw"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "Replace", map[string]interface{}{
		"file_path": filepath.Join(root, "note.txt"),
		"content":   "hello",
	})
	if err != nil {
		t.Fatalf("call Replace: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected read-only mode to block Replace")
	}

	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(strings.ToLower(content.Text), "read-only mode") {
		t.Fatalf("expected friendly read-only message, got %q", content.Text)
	}
}

func TestRootReadOnlyBlocksWriteTool(t *testing.T) {
	root := t.TempDir()
	server := newTestServer(t, Config{
		StableKey: "test-root-readonly",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "Replace", map[string]interface{}{
		"file_path": filepath.Join(root, "note.txt"),
		"content":   "hello",
	})
	if err != nil {
		t.Fatalf("call Replace: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected read-only root to block Replace")
	}

	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(strings.ToLower(content.Text), "not configured to trust server-issued relay authorizations") {
		t.Fatalf("expected local setting hint, got %q", content.Text)
	}
	denial := structuredRelayAccessDenial(t, result.StructuredContent)
	if denial["kind"] != "permission_denied" {
		t.Fatalf("expected permission_denied kind, got %#v", denial["kind"])
	}
	if denial["resolution"] != "local_setting" {
		t.Fatalf("expected local_setting resolution, got %#v", denial["resolution"])
	}
}

func TestSystemPathsRemainBlockedInGlobalMode(t *testing.T) {
	blocked := blockedSystemPaths()
	if len(blocked) == 0 {
		t.Skip("no blocked system paths configured for this OS")
	}

	server, err := New(Config{
		StableKey:    "test-global",
		Name:         "filesystem",
		Enabled:      true,
		Scope:        "global",
		GlobalAccess: "rw",
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})
	if err != nil {
		t.Fatalf("new filesystem server: %v", err)
	}

	result, err := server.CallTool(context.Background(), "View", map[string]interface{}{
		"file_path": blocked[0],
	})
	if err != nil {
		t.Fatalf("call View: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected blocked system path to stay inaccessible")
	}
}

func TestSearchFindsIndexedContent(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "note.md")
	if err := os.WriteFile(target, []byte("alpha beta gamma"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-search",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   true,
			FileTypes:        []string{".md"},
			MaxFileSizeBytes: 1024 * 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	if err := server.syncDirectoryTree(root); err != nil {
		t.Fatalf("sync directory tree: %v", err)
	}

	result, err := server.CallTool(context.Background(), "SearchFiles", map[string]interface{}{
		"query": "beta",
		"mode":  "content",
	})
	if err != nil {
		t.Fatalf("call SearchFiles: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected successful search, got error result")
	}

	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, target) {
		t.Fatalf("expected search results to contain %q, got %q", target, content.Text)
	}
}

func TestSyncDirectoryTreeReturnsCanceledWhenServerContextStops(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "note.txt")
	if err := os.WriteFile(target, []byte("plain text"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	server := newIndexOnlyTestServer(t, Config{
		StableKey: "test-sync-cancel",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024 * 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	server.startCtx, server.cancel = context.WithCancel(context.Background())
	server.cancel()

	err := server.syncDirectoryTree(root)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected sync to stop with context.Canceled, got %v", err)
	}
}

func TestViewWorksWithoutContentIndexing(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "note.txt")
	if err := os.WriteFile(target, []byte("plain text still readable"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-read-no-index",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024 * 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "View", map[string]interface{}{
		"file_path": target,
	})
	if err != nil {
		t.Fatalf("call View: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected View to succeed without content indexing")
	}

	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, "plain text still readable") {
		t.Fatalf("expected file content, got %q", content.Text)
	}
}

func TestGetFileReturnsBinaryResource(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "payload.bin")
	payload := []byte{0x00, 0x01, 0x02, 0x03, 0xff, 0x10}
	if err := os.WriteFile(target, payload, 0o644); err != nil {
		t.Fatalf("write payload: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey:           "test-get-file",
		Name:                "filesystem",
		Scope:               "roots",
		MaxGetFileSizeBytes: 1024,
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".bin"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "GetFile", map[string]interface{}{
		"file_path": target,
	})
	if err != nil {
		t.Fatalf("call GetFile: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected GetFile to succeed, got error result")
	}
	if len(result.Content) != 2 {
		t.Fatalf("expected text and resource content blocks, got %d", len(result.Content))
	}

	resource, ok := result.Content[1].(core.ResourceContent)
	if !ok {
		t.Fatalf("expected resource content, got %T", result.Content[1])
	}
	if resource.Resource.Name != "payload.bin" {
		t.Fatalf("expected resource name payload.bin, got %q", resource.Resource.Name)
	}
	if resource.Resource.MimeType != "application/octet-stream" {
		t.Fatalf("expected application/octet-stream, got %q", resource.Resource.MimeType)
	}
	if resource.Resource.Blob != base64.StdEncoding.EncodeToString(payload) {
		t.Fatalf("expected base64 payload to match file content")
	}
	if resource.Resource.Metadata["absolutePath"] != target {
		t.Fatalf("expected resource metadata absolutePath %q, got %#v", target, resource.Resource.Metadata["absolutePath"])
	}
	if _, ok := resource.Resource.Metadata["sha256"].(string); !ok {
		t.Fatalf("expected resource metadata sha256, got %#v", resource.Resource.Metadata["sha256"])
	}
	if _, ok := resource.Resource.Metadata["modifiedAt"].(string); !ok {
		t.Fatalf("expected resource metadata modifiedAt, got %#v", resource.Resource.Metadata["modifiedAt"])
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	if structured["file_path"] != target {
		t.Fatalf("expected structured file_path %q, got %#v", target, structured["file_path"])
	}
	if _, ok := structured["sha256"].(string); !ok {
		t.Fatalf("expected structured sha256, got %#v", structured["sha256"])
	}
	if _, ok := structured["modified_at"].(string); !ok {
		t.Fatalf("expected structured modified_at, got %#v", structured["modified_at"])
	}
}

func TestGetFileRejectsOversizedFile(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "large.bin")
	payload := strings.Repeat("a", 32)
	if err := os.WriteFile(target, []byte(payload), 0o644); err != nil {
		t.Fatalf("write payload: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey:           "test-get-file-limit",
		Name:                "filesystem",
		Scope:               "roots",
		MaxGetFileSizeBytes: 16,
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".bin"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "GetFile", map[string]interface{}{
		"file_path": target,
	})
	if err != nil {
		t.Fatalf("call GetFile: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected oversized GetFile request to fail")
	}

	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, "exceeds the configured GetFile limit") {
		t.Fatalf("expected size limit message, got %q", content.Text)
	}
}

func TestLegacyOfficeReadUsesLibreOfficeFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script based LibreOffice fallback test is only configured for Unix-like CI")
	}

	root := t.TempDir()
	target := filepath.Join(root, "legacy.doc")
	if err := os.WriteFile(target, []byte("placeholder legacy office bytes"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	scriptPath := filepath.Join(t.TempDir(), "fake-soffice")
	script := `#!/usr/bin/env bash
set -euo pipefail
outdir=""
input=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --outdir)
      outdir="$2"
      shift 2
      ;;
    --convert-to)
      shift 2
      ;;
    --headless|--nologo|--nolockcheck|--norestore)
      shift
      ;;
    *)
      input="$1"
      shift
      ;;
  esac
done
base="$(basename "$input")"
base="${base%.*}"
printf 'legacy office text via libreoffice fallback\n' > "$outdir/$base.txt"
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake soffice: %v", err)
	}
	t.Setenv("SYNAPSE_RELAY_SOFFICE", scriptPath)

	server := newTestServer(t, Config{
		StableKey: "test-legacy-office",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".doc"},
			MaxFileSizeBytes: 1024 * 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "View", map[string]interface{}{
		"file_path": target,
	})
	if err != nil {
		t.Fatalf("call View: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected legacy office read to succeed via fallback")
	}

	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, "legacy office text via libreoffice fallback") {
		t.Fatalf("expected fallback text, got %q", content.Text)
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content, got %T", result.StructuredContent)
	}
	if structured["parser"] != "office_legacy_libreoffice" {
		t.Fatalf("expected LibreOffice parser, got %#v", structured["parser"])
	}
}

func TestSearchSupportsFiltersSortingAndPaging(t *testing.T) {
	rootA := t.TempDir()
	rootB := t.TempDir()

	alphaPath := filepath.Join(rootA, "report.md")
	archivePath := filepath.Join(rootA, "archive", "report-archive.txt")
	bravoPath := filepath.Join(rootB, "zeta.md")
	if err := os.MkdirAll(filepath.Dir(archivePath), 0o755); err != nil {
		t.Fatalf("mkdir archive: %v", err)
	}
	fixtures := map[string]string{
		alphaPath:   "needle alpha",
		archivePath: "needle archive content that is longer",
		bravoPath:   "needle bravo",
	}
	for path, content := range fixtures {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write fixture %s: %v", path, err)
		}
	}

	server := newTestServer(t, Config{
		StableKey: "test-search-filters",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: rootA, Access: "ro"},
			{ID: "root_1", Path: rootB, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   true,
			FileTypes:        []string{".md", ".txt"},
			MaxFileSizeBytes: 1024 * 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	if err := server.syncDirectoryTree(rootA); err != nil {
		t.Fatalf("sync rootA: %v", err)
	}
	if err := server.syncDirectoryTree(rootB); err != nil {
		t.Fatalf("sync rootB: %v", err)
	}

	pathResults, err := server.searchIndex(SearchQuery{
		Query:      "report",
		Mode:       "path",
		Roots:      []string{"root_0"},
		Extensions: []string{".md"},
		EntryType:  "file",
		Limit:      10,
	})
	if err != nil {
		t.Fatalf("path search: %v", err)
	}
	if len(pathResults) != 1 {
		t.Fatalf("expected one path result after filters, got %d", len(pathResults))
	}
	if pathResults[0].Path != alphaPath {
		t.Fatalf("expected filtered result %q, got %q", alphaPath, pathResults[0].Path)
	}

	indexed := true
	contentResults, err := server.searchIndex(SearchQuery{
		Query:          "needle",
		Mode:           "content",
		Extensions:     []string{".md"},
		Parsers:        []string{"text"},
		ContentIndexed: &indexed,
		MinSizeBytes:   int64(len("needle alpha")),
		MaxSizeBytes:   int64(len("needle archive content that is longer")),
		SortBy:         "path",
		SortDirection:  "asc",
		Offset:         1,
		Limit:          1,
	})
	if err != nil {
		t.Fatalf("content search: %v", err)
	}
	if len(contentResults) != 1 {
		t.Fatalf("expected one paged content result, got %d", len(contentResults))
	}
	if contentResults[0].Path != bravoPath {
		t.Fatalf("expected second path-sorted result %q, got %q", bravoPath, contentResults[0].Path)
	}
	if contentResults[0].MatchMode != "content" {
		t.Fatalf("expected content match mode, got %q", contentResults[0].MatchMode)
	}
}

func TestContentIndexUsesMtimeAndSizeFingerprintWithoutRepeatedOCR(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script based OCR helper test is only configured for Unix-like CI")
	}

	root := t.TempDir()
	target := filepath.Join(root, "diagram.png")
	if err := os.WriteFile(target, []byte("fake image bytes"), 0o644); err != nil {
		t.Fatalf("write image fixture: %v", err)
	}

	counterPath := filepath.Join(t.TempDir(), "ocr-count.txt")
	scriptPath := filepath.Join(t.TempDir(), "fake-tesseract")
	script := `#!/usr/bin/env bash
set -euo pipefail
input="${1:-}"
output="${2:-}"
counter="${SYNAPSE_TEST_TESSERACT_COUNTER:?}"
count=0
if [ -f "$counter" ]; then
  count="$(cat "$counter")"
fi
count=$((count + 1))
printf '%s' "$count" > "$counter"
printf 'ocr content from %s\n' "$(basename "$input")" > "${output}.txt"
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake tesseract: %v", err)
	}
	t.Setenv("SYNAPSE_RELAY_TESSERACT", scriptPath)
	t.Setenv("SYNAPSE_TEST_TESSERACT_COUNTER", counterPath)

	server := newIndexOnlyTestServer(t, Config{
		StableKey: "test-image-fingerprint",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   true,
			FileTypes:        []string{".png"},
			MaxFileSizeBytes: 1024 * 1024,
			ParsePDF:         true,
			ParseOffice:      true,
			ParseImages:      true,
		},
	})

	if err := server.syncDirectoryTree(root); err != nil {
		t.Fatalf("first sync: %v", err)
	}
	if err := server.syncDirectoryTree(root); err != nil {
		t.Fatalf("second sync: %v", err)
	}

	countData, err := os.ReadFile(counterPath)
	if err != nil {
		t.Fatalf("read OCR counter: %v", err)
	}
	if strings.TrimSpace(string(countData)) != "1" {
		t.Fatalf("expected OCR helper to run once for unchanged file, got %q", strings.TrimSpace(string(countData)))
	}

	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat indexed file: %v", err)
	}

	var contentMtimeNS int64
	var contentSize int64
	var extractorKey string
	row := server.db.QueryRow(`SELECT content_mtime_ns, content_size_bytes, extractor_key FROM files WHERE abs_path = ?`, target)
	if err := row.Scan(&contentMtimeNS, &contentSize, &extractorKey); err != nil {
		t.Fatalf("scan indexed metadata: %v", err)
	}
	if contentMtimeNS != info.ModTime().UnixNano() {
		t.Fatalf("expected content_mtime_ns %d, got %d", info.ModTime().UnixNano(), contentMtimeNS)
	}
	if contentSize != info.Size() {
		t.Fatalf("expected content_size_bytes %d, got %d", info.Size(), contentSize)
	}
	if !strings.Contains(extractorKey, "image_ocr") {
		t.Fatalf("expected image OCR extractor key, got %q", extractorKey)
	}
}

func TestViewExtractsPPTXSlidesAndNotes(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "deck.pptx")

	handle, err := os.Create(target)
	if err != nil {
		t.Fatalf("create pptx fixture: %v", err)
	}
	archive := zip.NewWriter(handle)
	files := map[string]string{
		"ppt/slides/slide1.xml":           `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Quarterly review</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
		"ppt/notesSlides/notesSlide1.xml": `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker note reminder</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
	}
	for name, contents := range files {
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatalf("create zip member %s: %v", name, err)
		}
		if _, err := entry.Write([]byte(contents)); err != nil {
			t.Fatalf("write zip member %s: %v", name, err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatalf("close pptx archive: %v", err)
	}
	if err := handle.Close(); err != nil {
		t.Fatalf("close pptx file: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-pptx-read",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   true,
			FileTypes:        []string{".pptx"},
			MaxFileSizeBytes: 1024 * 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "View", map[string]interface{}{
		"file_path": target,
	})
	if err != nil {
		t.Fatalf("call View: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected pptx read to succeed")
	}

	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, "Quarterly review") {
		t.Fatalf("expected slide text, got %q", content.Text)
	}
	if !strings.Contains(content.Text, "Speaker note reminder") {
		t.Fatalf("expected notes text, got %q", content.Text)
	}
}

func TestDisabledFilesystemViewRejectsAccess(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "note.txt")
	if err := os.WriteFile(target, []byte("hello from disabled filesystem"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	server, err := New(Config{
		StableKey: "disabled-fs",
		Name:      "filesystem",
		Enabled:   false,
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})
	if err != nil {
		t.Fatalf("new filesystem server: %v", err)
	}
	if err := server.Start(context.Background()); err != nil {
		t.Fatalf("start filesystem server: %v", err)
	}
	t.Cleanup(server.Shutdown)

	blocked, err := server.CallTool(context.Background(), "View", map[string]interface{}{
		"file_path": target,
	})
	if err != nil {
		t.Fatalf("call View: %v", err)
	}
	if !blocked.IsError {
		t.Fatalf("expected disabled filesystem to reject access")
	}

	structured, ok := blocked.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", blocked.StructuredContent)
	}
	if structured["code"] != "directory_permission_required" {
		t.Fatalf("expected directory_permission_required code, got %#v", structured["code"])
	}
	denial := structuredRelayAccessDenial(t, blocked.StructuredContent)
	if denial["kind"] != "permission_denied" {
		t.Fatalf("expected permission_denied kind, got %#v", denial["kind"])
	}
	if denial["resolution"] != "local_setting" {
		t.Fatalf("expected local_setting resolution, got %#v", denial["resolution"])
	}
}

func TestFilesystemSymlinkAccessReturnsUnresolvableConstraint(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink setup is not reliable on Windows CI")
	}

	root := t.TempDir()
	target := filepath.Join(root, "target.txt")
	link := filepath.Join(root, "linked.txt")
	if err := os.WriteFile(target, []byte("hello through symlink"), 0o644); err != nil {
		t.Fatalf("write target: %v", err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("create symlink: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "symlink-fs",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "View", map[string]interface{}{
		"file_path": link,
	})
	if err != nil {
		t.Fatalf("call View: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected symlink access to be rejected")
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	if structured["code"] != "symlink_not_allowed" {
		t.Fatalf("expected symlink_not_allowed code, got %#v", structured["code"])
	}
	denial := structuredRelayAccessDenial(t, result.StructuredContent)
	if denial["kind"] != "runtime_constraint" {
		t.Fatalf("expected runtime_constraint kind, got %#v", denial["kind"])
	}
	if denial["resolution"] != "unresolvable" {
		t.Fatalf("expected unresolvable resolution, got %#v", denial["resolution"])
	}
}

func TestServerAuthorizationBypassesDisabledFilesystemLocalGuards(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "note.txt")
	if err := os.WriteFile(target, []byte("hello from server authorized filesystem"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	server, err := New(Config{
		StableKey:                "server-auth-fs",
		Name:                     "filesystem",
		Enabled:                  false,
		AllowServerAuthorization: true,
		ReadOnly:                 true,
		Scope:                    "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})
	if err != nil {
		t.Fatalf("new filesystem server: %v", err)
	}
	if err := server.Start(context.Background()); err != nil {
		t.Fatalf("start filesystem server: %v", err)
	}
	t.Cleanup(server.Shutdown)

	serverAuthorizedCtx := runtimeauth.ContextWithRuntimeAuthorization(
		context.Background(),
		runtimeauth.RuntimeAuthorization{
			GrantIDs: []string{"grant-fs-1"},
			GrantSpecs: []map[string]interface{}{
				{
					"capability": "filesystem",
					"filesystem": map[string]interface{}{
						"access":       "read",
						"pathPrefixes": []string{root},
					},
				},
				{
					"capability": "filesystem",
					"filesystem": map[string]interface{}{
						"access":       "write",
						"pathPrefixes": []string{root},
					},
				},
			},
		},
	)

	viewed, err := server.CallTool(serverAuthorizedCtx, "View", map[string]interface{}{
		"file_path": target,
	})
	if err != nil {
		t.Fatalf("call View: %v", err)
	}
	if viewed.IsError {
		t.Fatalf("expected server-authorized view to succeed, got %+v", viewed.StructuredContent)
	}
	content, ok := viewed.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", viewed.Content[0])
	}
	if !strings.Contains(content.Text, "hello from server authorized filesystem") {
		t.Fatalf("expected viewed content to include file contents, got %q", content.Text)
	}

	replaced, err := server.CallTool(serverAuthorizedCtx, "Replace", map[string]interface{}{
		"file_path": target,
		"content":   "updated by server authorization",
	})
	if err != nil {
		t.Fatalf("call Replace: %v", err)
	}
	if replaced.IsError {
		t.Fatalf("expected server-authorized replace to succeed, got %+v", replaced.StructuredContent)
	}
	updatedBytes, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read updated file: %v", err)
	}
	if string(updatedBytes) != "updated by server authorization" {
		t.Fatalf("expected server-authorized replace to update file, got %q", string(updatedBytes))
	}
}

func TestLSSupportsPaginationSortingAndFiltering(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"alpha.txt": "a",
		"beta.txt":  "bb",
		"gamma.md":  "ccc",
	}
	for name, contents := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(contents), 0o644); err != nil {
			t.Fatalf("write fixture %s: %v", name, err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "assets"), 0o755); err != nil {
		t.Fatalf("mkdir assets: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-ls",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt", ".md"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "LS", map[string]interface{}{
		"directory_path": root,
		"name_contains":  "a",
		"entry_type":     "file",
		"sort_by":        "name",
		"sort_direction": "asc",
		"offset":         1,
		"limit":          2,
	})
	if err != nil {
		t.Fatalf("call LS: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected LS to succeed")
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	if structured["total"] != 3 {
		t.Fatalf("expected total 3 filtered file entries, got %#v", structured["total"])
	}
	entries, ok := structured["entries"].([]map[string]interface{})
	if !ok {
		t.Fatalf("expected entries slice, got %T", structured["entries"])
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 paged entries, got %d", len(entries))
	}
	if entries[0]["name"] != "beta.txt" || entries[1]["name"] != "gamma.md" {
		t.Fatalf("unexpected paged entry order: %+v", entries)
	}
}

func TestGlobAndGrepToolsFindMatchingFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatalf("mkdir src: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "alpha.ts"), []byte("const hello = 'world'\n"), 0o644); err != nil {
		t.Fatalf("write alpha.ts: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "beta.tsx"), []byte("console.log('hello world')\n"), 0o644); err != nil {
		t.Fatalf("write beta.tsx: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("hello world\n"), 0o644); err != nil {
		t.Fatalf("write README.md: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-glob-grep",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".ts", ".tsx", ".md"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	globResult, err := server.CallTool(context.Background(), "GlobTool", map[string]interface{}{
		"path":    root,
		"pattern": "src/**/*.ts*",
	})
	if err != nil {
		t.Fatalf("call GlobTool: %v", err)
	}
	if globResult.IsError {
		t.Fatalf("expected GlobTool to succeed")
	}
	globText, ok := globResult.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", globResult.Content[0])
	}
	if !strings.Contains(globText.Text, filepath.Join(root, "src", "alpha.ts")) || !strings.Contains(globText.Text, filepath.Join(root, "src", "beta.tsx")) {
		t.Fatalf("unexpected glob results: %q", globText.Text)
	}

	grepResult, err := server.CallTool(context.Background(), "GrepTool", map[string]interface{}{
		"path":           root,
		"pattern":        "hello\\s+world",
		"include":        "*.{ts,tsx}",
		"output_mode":    "content",
		"context_before": 1,
		"context_after":  1,
	})
	if err != nil {
		t.Fatalf("call GrepTool: %v", err)
	}
	if grepResult.IsError {
		t.Fatalf("expected GrepTool to succeed")
	}
	grepText, ok := grepResult.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", grepResult.Content[0])
	}
	if !strings.Contains(grepText.Text, filepath.Join(root, "src", "beta.tsx")+":1:") {
		t.Fatalf("expected grep result to include beta.tsx, got %q", grepText.Text)
	}
	if strings.Contains(grepText.Text, filepath.Join(root, "README.md")) {
		t.Fatalf("expected include filter to exclude README.md, got %q", grepText.Text)
	}

	structured, ok := grepResult.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", grepResult.StructuredContent)
	}
	if structured["mode"] != "content" {
		t.Fatalf("expected content mode, got %#v", structured["mode"])
	}
	matches, ok := structured["matches"].([]map[string]interface{})
	if !ok {
		t.Fatalf("expected matches slice, got %T", structured["matches"])
	}
	if len(matches) != 1 {
		t.Fatalf("expected one matching location, got %d", len(matches))
	}
	if matches[0]["path"] != filepath.Join(root, "src", "beta.tsx") {
		t.Fatalf("expected structured match to point at beta.tsx, got %#v", matches[0]["path"])
	}
	if matches[0]["line"] != 1 {
		t.Fatalf("expected line 1, got %#v", matches[0]["line"])
	}
}

func TestGlobToolSupportsPagingAfterModifiedSort(t *testing.T) {
	root := t.TempDir()
	paths := []string{
		filepath.Join(root, "alpha.txt"),
		filepath.Join(root, "beta.txt"),
		filepath.Join(root, "gamma.txt"),
	}
	for _, path := range paths {
		if err := os.WriteFile(path, []byte(path), 0o644); err != nil {
			t.Fatalf("write %s: %v", filepath.Base(path), err)
		}
	}
	now := time.Now()
	if err := os.Chtimes(paths[0], now.Add(-3*time.Hour), now.Add(-3*time.Hour)); err != nil {
		t.Fatalf("chtimes alpha: %v", err)
	}
	if err := os.Chtimes(paths[1], now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatalf("chtimes beta: %v", err)
	}
	if err := os.Chtimes(paths[2], now.Add(-1*time.Hour), now.Add(-1*time.Hour)); err != nil {
		t.Fatalf("chtimes gamma: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-glob-paging",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "GlobTool", map[string]interface{}{
		"path":    root,
		"pattern": "*.txt",
		"offset":  1,
		"limit":   1,
	})
	if err != nil {
		t.Fatalf("call GlobTool: %v", err)
	}
	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	if structured["total"] != 3 {
		t.Fatalf("expected total 3, got %#v", structured["total"])
	}
	if structured["has_more"] != true {
		t.Fatalf("expected has_more=true, got %#v", structured["has_more"])
	}
	if structured["backend"] != "ripgrep" && structured["backend"] != "walk_fallback" {
		t.Fatalf("unexpected backend %#v", structured["backend"])
	}
	matches, ok := structured["matches"].([]map[string]interface{})
	if !ok {
		t.Fatalf("expected matches slice, got %T", structured["matches"])
	}
	if len(matches) != 1 {
		t.Fatalf("expected one paged match, got %d", len(matches))
	}
	if matches[0]["path"] != paths[1] {
		t.Fatalf("expected beta.txt as the paged result, got %#v", matches[0]["path"])
	}
}

func TestGrepToolAppliesMaxMatchesAfterModifiedSort(t *testing.T) {
	root := t.TempDir()
	older := filepath.Join(root, "aaa.txt")
	newer := filepath.Join(root, "zzz.txt")
	if err := os.WriteFile(older, []byte("needle in old file\n"), 0o644); err != nil {
		t.Fatalf("write older file: %v", err)
	}
	if err := os.WriteFile(newer, []byte("needle in new file\n"), 0o644); err != nil {
		t.Fatalf("write newer file: %v", err)
	}
	now := time.Now()
	if err := os.Chtimes(older, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatalf("chtimes older file: %v", err)
	}
	if err := os.Chtimes(newer, now.Add(-1*time.Hour), now.Add(-1*time.Hour)); err != nil {
		t.Fatalf("chtimes newer file: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-grep-sort-limit",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "GrepTool", map[string]interface{}{
		"path":        root,
		"pattern":     "needle",
		"output_mode": "content",
		"max_matches": 1,
	})
	if err != nil {
		t.Fatalf("call GrepTool: %v", err)
	}
	text, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if strings.Contains(text.Text, older) {
		t.Fatalf("expected max_matches to keep the newer file first, got %q", text.Text)
	}
	if !strings.Contains(text.Text, newer) {
		t.Fatalf("expected grep result to include newer file, got %q", text.Text)
	}
}

func TestGrepToolDefaultsToFilesWithMatchesAndSupportsPagingAfterModifiedSort(t *testing.T) {
	root := t.TempDir()
	paths := []string{
		filepath.Join(root, "alpha.txt"),
		filepath.Join(root, "beta.txt"),
		filepath.Join(root, "gamma.txt"),
	}
	for _, path := range paths {
		if err := os.WriteFile(path, []byte("needle in "+filepath.Base(path)), 0o644); err != nil {
			t.Fatalf("write %s: %v", filepath.Base(path), err)
		}
	}
	now := time.Now()
	if err := os.Chtimes(paths[0], now.Add(-3*time.Hour), now.Add(-3*time.Hour)); err != nil {
		t.Fatalf("chtimes alpha: %v", err)
	}
	if err := os.Chtimes(paths[1], now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatalf("chtimes beta: %v", err)
	}
	if err := os.Chtimes(paths[2], now.Add(-1*time.Hour), now.Add(-1*time.Hour)); err != nil {
		t.Fatalf("chtimes gamma: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-grep-files-mode",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "GrepTool", map[string]interface{}{
		"path":       root,
		"pattern":    "needle",
		"offset":     1,
		"head_limit": 1,
	})
	if err != nil {
		t.Fatalf("call GrepTool: %v", err)
	}
	text, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if strings.Contains(text.Text, paths[2]) || strings.Contains(text.Text, paths[0]) {
		t.Fatalf("expected paged file list to contain only beta.txt, got %q", text.Text)
	}
	if !strings.Contains(text.Text, paths[1]) {
		t.Fatalf("expected paged file list to include beta.txt, got %q", text.Text)
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	if structured["mode"] != "files_with_matches" {
		t.Fatalf("expected files_with_matches mode, got %#v", structured["mode"])
	}
	if structured["total_files"] != 3 {
		t.Fatalf("expected total_files=3, got %#v", structured["total_files"])
	}
	if structured["has_more"] != true {
		t.Fatalf("expected has_more=true, got %#v", structured["has_more"])
	}
	files, ok := structured["files"].([]map[string]interface{})
	if !ok {
		t.Fatalf("expected files slice, got %T", structured["files"])
	}
	if len(files) != 1 || files[0]["path"] != paths[1] {
		t.Fatalf("expected paged files result to contain beta.txt, got %+v", files)
	}
}

func TestGrepToolCountModeReturnsPerFileTotals(t *testing.T) {
	root := t.TempDir()
	older := filepath.Join(root, "alpha.txt")
	newer := filepath.Join(root, "beta.txt")
	if err := os.WriteFile(older, []byte("needle one\nneedle two\n"), 0o644); err != nil {
		t.Fatalf("write older file: %v", err)
	}
	if err := os.WriteFile(newer, []byte("needle three\n"), 0o644); err != nil {
		t.Fatalf("write newer file: %v", err)
	}
	now := time.Now()
	if err := os.Chtimes(older, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatalf("chtimes older file: %v", err)
	}
	if err := os.Chtimes(newer, now.Add(-1*time.Hour), now.Add(-1*time.Hour)); err != nil {
		t.Fatalf("chtimes newer file: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-grep-count-mode",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "GrepTool", map[string]interface{}{
		"path":        root,
		"pattern":     "needle",
		"output_mode": "count",
	})
	if err != nil {
		t.Fatalf("call GrepTool: %v", err)
	}
	text, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	newerLine := fmt.Sprintf("%s:%d", newer, 1)
	olderLine := fmt.Sprintf("%s:%d", older, 2)
	if !strings.Contains(text.Text, newerLine) || !strings.Contains(text.Text, olderLine) {
		t.Fatalf("expected count lines for both files, got %q", text.Text)
	}
	if strings.Index(text.Text, newerLine) > strings.Index(text.Text, olderLine) {
		t.Fatalf("expected newer file to appear first in count mode, got %q", text.Text)
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	if structured["mode"] != "count" {
		t.Fatalf("expected count mode, got %#v", structured["mode"])
	}
	if structured["total_matches"] != 3 {
		t.Fatalf("expected total_matches=3, got %#v", structured["total_matches"])
	}
	counts, ok := structured["counts"].([]map[string]interface{})
	if !ok {
		t.Fatalf("expected counts slice, got %T", structured["counts"])
	}
	if len(counts) != 2 || counts[0]["path"] != newer || counts[1]["path"] != older {
		t.Fatalf("unexpected count ordering: %+v", counts)
	}
}

func TestEditAndReplaceToolsModifyTextFiles(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "note.txt")
	if err := os.WriteFile(target, []byte("hello old world"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-edit-replace",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "rw"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	editResult, err := server.CallTool(context.Background(), "Edit", map[string]interface{}{
		"file_path":  target,
		"old_string": "hello old world",
		"new_string": "hello new world",
	})
	if err != nil {
		t.Fatalf("call Edit: %v", err)
	}
	if editResult.IsError {
		t.Fatalf("expected Edit to succeed")
	}
	edited, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read edited file: %v", err)
	}
	if string(edited) != "hello new world" {
		t.Fatalf("unexpected edited content %q", string(edited))
	}

	replaceResult, err := server.CallTool(context.Background(), "Replace", map[string]interface{}{
		"file_path": target,
		"content":   "replacement text",
	})
	if err != nil {
		t.Fatalf("call Replace: %v", err)
	}
	if replaceResult.IsError {
		t.Fatalf("expected Replace to succeed")
	}
	replaced, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read replaced file: %v", err)
	}
	if string(replaced) != "replacement text" {
		t.Fatalf("unexpected replaced content %q", string(replaced))
	}
}

func TestViewManyReadsMultipleFiles(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "alpha.txt")
	second := filepath.Join(root, "beta.txt")
	if err := os.WriteFile(first, []byte("alpha line 1\nalpha line 2"), 0o644); err != nil {
		t.Fatalf("write alpha: %v", err)
	}
	if err := os.WriteFile(second, []byte("beta line 1\nbeta line 2"), 0o644); err != nil {
		t.Fatalf("write beta: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-view-many",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "ViewMany", map[string]interface{}{
		"files": []map[string]interface{}{
			{"file_path": first},
			{"file_path": second, "offset": 1, "limit": 1},
		},
	})
	if err != nil {
		t.Fatalf("call ViewMany: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected ViewMany to succeed")
	}

	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, "== "+first+" ==") || !strings.Contains(content.Text, "alpha line 1") {
		t.Fatalf("unexpected ViewMany content %q", content.Text)
	}
	if !strings.Contains(content.Text, "beta line 2") {
		t.Fatalf("expected offset/limit content for second file, got %q", content.Text)
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	files, ok := structured["files"].([]map[string]interface{})
	if !ok || len(files) != 2 {
		t.Fatalf("expected two structured files, got %#v", structured["files"])
	}
	if files[1]["returned_lines"] != 1 {
		t.Fatalf("expected second file to return one line, got %#v", files[1]["returned_lines"])
	}
}

func TestPatchUpdateStructuredDataAndBackups(t *testing.T) {
	root := t.TempDir()
	backupDir := filepath.Join(t.TempDir(), "backups")
	target := filepath.Join(root, "note.txt")
	if err := os.WriteFile(target, []byte("hello old world"), 0o644); err != nil {
		t.Fatalf("write note: %v", err)
	}
	configPath := filepath.Join(root, "config.yaml")
	if err := os.WriteFile(configPath, []byte("service:\n  name: relay\n  enabled: false\n"), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-patch-backup",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "rw"},
		},
		Backup: BackupConfig{
			Dir:               backupDir,
			Enabled:           true,
			MaxTotalSizeBytes: 4 * 1024 * 1024,
			MaxFileSizeBytes:  1024 * 1024,
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt", ".yaml"},
			MaxFileSizeBytes: 1024 * 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	patchResult, err := server.CallTool(context.Background(), "Patch", map[string]interface{}{
		"operations": []map[string]interface{}{
			{
				"file_path":  target,
				"old_string": "hello old world",
				"new_string": "hello new world",
			},
		},
	})
	if err != nil {
		t.Fatalf("call Patch: %v", err)
	}
	if patchResult.IsError {
		t.Fatalf("expected Patch to succeed")
	}
	structured, ok := patchResult.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", patchResult.StructuredContent)
	}
	backups, ok := structured["backups"].([]map[string]interface{})
	if !ok || len(backups) != 1 {
		t.Fatalf("expected one backup entry, got %#v", structured["backups"])
	}
	backupID, ok := backups[0]["backup_id"].(string)
	if !ok || backupID == "" {
		t.Fatalf("expected backup id, got %#v", backups[0]["backup_id"])
	}

	updated, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read patched file: %v", err)
	}
	if string(updated) != "hello new world" {
		t.Fatalf("unexpected patched content %q", string(updated))
	}

	backupResult, err := server.CallTool(context.Background(), "GetBackup", map[string]interface{}{
		"backup_id": backupID,
	})
	if err != nil {
		t.Fatalf("call GetBackup: %v", err)
	}
	if backupResult.IsError {
		t.Fatalf("expected GetBackup to succeed")
	}
	backupContent, ok := backupResult.Content[1].(core.TextContent)
	if !ok {
		t.Fatalf("expected text preview as second block, got %T", backupResult.Content[1])
	}
	if !strings.Contains(backupContent.Text, "hello old world") {
		t.Fatalf("expected backup preview to show original content, got %q", backupContent.Text)
	}

	listResult, err := server.CallTool(context.Background(), "ListBackups", map[string]interface{}{
		"path": target,
	})
	if err != nil {
		t.Fatalf("call ListBackups: %v", err)
	}
	if listResult.IsError {
		t.Fatalf("expected ListBackups to succeed")
	}
	listStructured, ok := listResult.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", listResult.StructuredContent)
	}
	listBackups, ok := listStructured["backups"].([]map[string]interface{})
	if !ok || len(listBackups) < 1 {
		t.Fatalf("expected at least one listed backup, got %#v", listStructured["backups"])
	}
	if listStructured["limit_bytes"] != int64(4*1024*1024) {
		t.Fatalf("expected backup limit bytes, got %#v", listStructured["limit_bytes"])
	}
	if listStructured["pruned_count"] != int64(0) {
		t.Fatalf("expected pruned_count 0, got %#v", listStructured["pruned_count"])
	}

	restoreResult, err := server.CallTool(context.Background(), "RestoreBackup", map[string]interface{}{
		"backup_id": backupID,
	})
	if err != nil {
		t.Fatalf("call RestoreBackup: %v", err)
	}
	if restoreResult.IsError {
		t.Fatalf("expected RestoreBackup to succeed")
	}
	restored, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read restored file: %v", err)
	}
	if string(restored) != "hello old world" {
		t.Fatalf("unexpected restored content %q", string(restored))
	}

	updateResult, err := server.CallTool(context.Background(), "UpdateStructuredData", map[string]interface{}{
		"file_path": configPath,
		"updates": []map[string]interface{}{
			{"path": "service.enabled", "action": "set", "value": true},
			{"path": "service.port", "value": 8080},
		},
	})
	if err != nil {
		t.Fatalf("call UpdateStructuredData: %v", err)
	}
	if updateResult.IsError {
		t.Fatalf("expected UpdateStructuredData to succeed")
	}
	configData, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read updated config: %v", err)
	}
	configText := string(configData)
	if !strings.Contains(configText, "enabled: true") || !strings.Contains(configText, "port: 8080") {
		t.Fatalf("unexpected updated structured data %q", configText)
	}
}

func TestCopyAndDeleteReturnBackupStatus(t *testing.T) {
	root := t.TempDir()
	backupDir := filepath.Join(t.TempDir(), "backups")
	source := filepath.Join(root, "source.txt")
	destination := filepath.Join(root, "destination.txt")
	if err := os.WriteFile(source, []byte("source payload"), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}
	if err := os.WriteFile(destination, []byte("old destination"), 0o644); err != nil {
		t.Fatalf("write destination: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-copy-delete",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "rw"},
		},
		Backup: BackupConfig{
			Dir:               backupDir,
			Enabled:           true,
			MaxTotalSizeBytes: 4 * 1024 * 1024,
			MaxFileSizeBytes:  1024 * 1024,
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024 * 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	copyResult, err := server.CallTool(context.Background(), "Copy", map[string]interface{}{
		"source_path":      source,
		"destination_path": destination,
		"overwrite":        true,
	})
	if err != nil {
		t.Fatalf("call Copy: %v", err)
	}
	if copyResult.IsError {
		t.Fatalf("expected Copy to succeed")
	}
	copied, err := os.ReadFile(destination)
	if err != nil {
		t.Fatalf("read copied destination: %v", err)
	}
	if string(copied) != "source payload" {
		t.Fatalf("unexpected copied content %q", string(copied))
	}
	copyStructured, ok := copyResult.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", copyResult.StructuredContent)
	}
	copyBackups, ok := copyStructured["backups"].([]map[string]interface{})
	if !ok || len(copyBackups) != 1 || copyBackups[0]["status"] != "created" {
		t.Fatalf("expected created backup for overwritten destination, got %#v", copyStructured["backups"])
	}

	deleteResult, err := server.CallTool(context.Background(), "Delete", map[string]interface{}{
		"path": source,
	})
	if err != nil {
		t.Fatalf("call Delete: %v", err)
	}
	if deleteResult.IsError {
		t.Fatalf("expected Delete to succeed")
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("expected source to be deleted, stat err=%v", err)
	}
	deleteStructured, ok := deleteResult.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", deleteResult.StructuredContent)
	}
	deleteBackups, ok := deleteStructured["backups"].([]map[string]interface{})
	if !ok || len(deleteBackups) != 1 || deleteBackups[0]["status"] != "created" {
		t.Fatalf("expected created backup for deleted source, got %#v", deleteStructured["backups"])
	}
}

func TestReplacePreservesPermissionsLineEndingsAndSearchFreshness(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "script.txt")
	if err := os.WriteFile(target, []byte("old value\r\n"), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-replace-freshness",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "rw"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   true,
			FileTypes:        []string{".txt", ".tmp"},
			MaxFileSizeBytes: 1024 * 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	result, err := server.CallTool(context.Background(), "Replace", map[string]interface{}{
		"file_path": target,
		"content":   "new value\n",
	})
	if err != nil {
		t.Fatalf("call Replace: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected Replace to succeed")
	}

	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read replaced script: %v", err)
	}
	if string(data) != "new value\r\n" {
		t.Fatalf("expected CRLF line endings to be preserved, got %q", string(data))
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat replaced script: %v", err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("expected mode 0755 to be preserved, got %#o", info.Mode().Perm())
	}

	searchResult, err := server.CallTool(context.Background(), "SearchFiles", map[string]interface{}{
		"query": "new value",
		"mode":  "content",
	})
	if err != nil {
		t.Fatalf("call SearchFiles: %v", err)
	}
	if searchResult.IsError {
		t.Fatalf("expected SearchFiles to see the fresh Replace result")
	}
	searchText, ok := searchResult.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", searchResult.Content[0])
	}
	if !strings.Contains(searchText.Text, target) {
		t.Fatalf("expected SearchFiles to include %q, got %q", target, searchText.Text)
	}
}

func TestSearchToolsSupportExcludeAndGitignore(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "node_modules"), 0o755); err != nil {
		t.Fatalf("mkdir node_modules: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("secret.txt\n"), 0o644); err != nil {
		t.Fatalf("write .gitignore: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", ".gitignore"), []byte("nested.txt\n*.tmp\n!keep.tmp\n"), 0o644); err != nil {
		t.Fatalf("write sub/.gitignore: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "visible.txt"), []byte("needle visible\n"), 0o644); err != nil {
		t.Fatalf("write visible.txt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "secret.txt"), []byte("needle secret\n"), 0o644); err != nil {
		t.Fatalf("write secret.txt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "nested.txt"), []byte("needle nested ignored\n"), 0o644); err != nil {
		t.Fatalf("write nested.txt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "keep.tmp"), []byte("needle nested kept\n"), 0o644); err != nil {
		t.Fatalf("write keep.tmp: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "drop.tmp"), []byte("needle nested dropped\n"), 0o644); err != nil {
		t.Fatalf("write drop.tmp: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "node_modules", "ignored.txt"), []byte("needle ignored\n"), 0o644); err != nil {
		t.Fatalf("write ignored.txt: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-search-filters",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   true,
			FileTypes:        []string{".txt", ".tmp"},
			MaxFileSizeBytes: 1024 * 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})
	if err := server.syncDirectoryTree(root); err != nil {
		t.Fatalf("sync directory tree: %v", err)
	}

	globResult, err := server.CallTool(context.Background(), "GlobTool", map[string]interface{}{
		"path":    root,
		"pattern": "**/*.txt",
	})
	if err != nil {
		t.Fatalf("call GlobTool: %v", err)
	}
	globText, ok := globResult.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", globResult.Content[0])
	}
	if strings.Contains(globText.Text, filepath.Join(root, "node_modules", "ignored.txt")) {
		t.Fatalf("expected default noisy directories to be excluded, got %q", globText.Text)
	}

	grepResult, err := server.CallTool(context.Background(), "GrepTool", map[string]interface{}{
		"path":              root,
		"pattern":           "needle",
		"exclude":           []string{"visible.txt"},
		"respect_gitignore": true,
	})
	if err != nil {
		t.Fatalf("call GrepTool: %v", err)
	}
	grepText, ok := grepResult.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", grepResult.Content[0])
	}
	if strings.Contains(grepText.Text, filepath.Join(root, "visible.txt")) || strings.Contains(grepText.Text, filepath.Join(root, "secret.txt")) || strings.Contains(grepText.Text, filepath.Join(root, "sub", "nested.txt")) || strings.Contains(grepText.Text, filepath.Join(root, "sub", "drop.tmp")) {
		t.Fatalf("expected grep to exclude ignored files, got %q", grepText.Text)
	}
	if !strings.Contains(grepText.Text, filepath.Join(root, "sub", "keep.tmp")) {
		t.Fatalf("expected grep to keep the re-included nested file, got %q", grepText.Text)
	}

	searchResult, err := server.CallTool(context.Background(), "SearchFiles", map[string]interface{}{
		"query":             "needle",
		"mode":              "content",
		"exclude":           []string{"visible.txt"},
		"respect_gitignore": true,
	})
	if err != nil {
		t.Fatalf("call SearchFiles: %v", err)
	}
	searchStructured, ok := searchResult.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", searchResult.StructuredContent)
	}
	results, ok := searchStructured["results"].([]SearchResult)
	if !ok {
		t.Fatalf("expected search results slice, got %T", searchStructured["results"])
	}
	if len(results) != 1 {
		t.Fatalf("expected SearchFiles to keep only the re-included nested file, got %+v", results)
	}
	if results[0].Path != filepath.Join(root, "sub", "keep.tmp") {
		t.Fatalf("expected only keep.tmp to remain, got %+v", results)
	}
}

func structuredRelayAccessDenial(t *testing.T, structuredContent interface{}) map[string]interface{} {
	t.Helper()
	structured, ok := structuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", structuredContent)
	}
	denial, ok := structured["relay_access_denial"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected relay_access_denial map, got %#v", structured["relay_access_denial"])
	}
	return denial
}
