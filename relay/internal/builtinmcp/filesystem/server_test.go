package filesystem

import (
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
)

func newTestServer(t *testing.T, cfg Config) *Server {
	t.Helper()

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

	result, err := server.CallTool(context.Background(), "write_file", map[string]interface{}{
		"path":    filepath.Join(root, "note.txt"),
		"content": "hello",
	})
	if err != nil {
		t.Fatalf("call write_file: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected read-only mode to block write_file")
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

	result, err := server.CallTool(context.Background(), "write_file", map[string]interface{}{
		"path":    filepath.Join(root, "note.txt"),
		"content": "hello",
	})
	if err != nil {
		t.Fatalf("call write_file: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected read-only root to block write_file")
	}

	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(strings.ToLower(content.Text), "grant write access") {
		t.Fatalf("expected client authorization hint, got %q", content.Text)
	}
}

func TestSessionGrantAllowsWriteOnlyForMatchingRuntimeSession(t *testing.T) {
	root := t.TempDir()
	authStore := runtimeauth.NewStore(filepath.Join(t.TempDir(), "runtime-auth.json"))
	if err := authStore.OpenSession(runtimeauth.RuntimeSession{
		ID:                "fs-session-a",
		ExposureStableKey: "test-session-grant",
	}); err != nil {
		t.Fatalf("open session-a: %v", err)
	}
	if err := authStore.OpenSession(runtimeauth.RuntimeSession{
		ID:                "fs-session-b",
		ExposureStableKey: "test-session-grant",
	}); err != nil {
		t.Fatalf("open session-b: %v", err)
	}
	if err := authStore.Apply(runtimeauth.Grant{
		InteractionID:     "grant-session-a",
		RuntimeSessionID:  "fs-session-a",
		ExposureStableKey: "test-session-grant",
		Duration:          "session",
		Capability:        "filesystem",
		Path:              root,
		Access:            "read_write",
	}); err != nil {
		t.Fatalf("apply runtime session grant: %v", err)
	}

	server := newTestServer(t, Config{
		StableKey: "test-session-grant",
		Name:      "filesystem",
		Scope:     "roots",
		Roots: []Root{
			{ID: "root_0", Path: root, Access: "ro"},
		},
		AuthStore: authStore,
		Index: IndexConfig{
			Dir:              filepath.Join(t.TempDir(), "index"),
			ContentEnabled:   false,
			FileTypes:        []string{".txt"},
			MaxFileSizeBytes: 1024,
			ParsePDF:         true,
			ParseOffice:      true,
		},
	})

	target := filepath.Join(root, "session-note.txt")

	noSessionResult, err := server.CallTool(context.Background(), "write_file", map[string]interface{}{
		"path":    target,
		"content": "blocked",
	})
	if err != nil {
		t.Fatalf("call write_file without session: %v", err)
	}
	if !noSessionResult.IsError {
		t.Fatalf("expected write_file without runtime session to be blocked")
	}

	otherSessionCtx := runtimeauth.ContextWithRuntimeSessionID(context.Background(), "fs-session-b")
	otherSessionResult, err := server.CallTool(otherSessionCtx, "write_file", map[string]interface{}{
		"path":    target,
		"content": "still blocked",
	})
	if err != nil {
		t.Fatalf("call write_file for other session: %v", err)
	}
	if !otherSessionResult.IsError {
		t.Fatalf("expected write_file for different runtime session to remain blocked")
	}

	grantedCtx := runtimeauth.ContextWithRuntimeSessionID(context.Background(), "fs-session-a")
	grantedResult, err := server.CallTool(grantedCtx, "write_file", map[string]interface{}{
		"path":    target,
		"content": "allowed",
	})
	if err != nil {
		t.Fatalf("call write_file for granted session: %v", err)
	}
	if grantedResult.IsError {
		t.Fatalf("expected write_file for granted runtime session to succeed")
	}

	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if string(data) != "allowed" {
		t.Fatalf("expected granted write to persist file content, got %q", string(data))
	}

	authStore.CloseSession("fs-session-a")
	afterCloseResult, err := server.CallTool(grantedCtx, "write_file", map[string]interface{}{
		"path":    target,
		"content": "blocked again",
	})
	if err != nil {
		t.Fatalf("call write_file after session close: %v", err)
	}
	if !afterCloseResult.IsError {
		t.Fatalf("expected closed runtime session grant to be removed")
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

	result, err := server.CallTool(context.Background(), "read_text_file", map[string]interface{}{
		"path": blocked[0],
	})
	if err != nil {
		t.Fatalf("call read_text_file: %v", err)
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

	result, err := server.CallTool(context.Background(), "search_files", map[string]interface{}{
		"query": "beta",
		"mode":  "content",
	})
	if err != nil {
		t.Fatalf("call search_files: %v", err)
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

func TestReadTextFileWorksWithoutContentIndexing(t *testing.T) {
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

	result, err := server.CallTool(context.Background(), "read_text_file", map[string]interface{}{
		"path": target,
	})
	if err != nil {
		t.Fatalf("call read_text_file: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected read_text_file to succeed without content indexing")
	}

	content, ok := result.Content[0].(core.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	if !strings.Contains(content.Text, "plain text still readable") {
		t.Fatalf("expected file content, got %q", content.Text)
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

	result, err := server.CallTool(context.Background(), "read_text_file", map[string]interface{}{
		"path": target,
	})
	if err != nil {
		t.Fatalf("call read_text_file: %v", err)
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
		Type:       "file",
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

func TestReadTextFileExtractsPPTXSlidesAndNotes(t *testing.T) {
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

	result, err := server.CallTool(context.Background(), "read_text_file", map[string]interface{}{
		"path": target,
	})
	if err != nil {
		t.Fatalf("call read_text_file: %v", err)
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
