//go:build relay_fuse

package vfsmount

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
	"github.com/PekingSpades/Synapse/relay/internal/vfs"
	"github.com/winfsp/cgofuse/fuse"
)

type stubBackend struct {
	exposures []vfs.Exposure
	calls     []stubToolCall
	handlers  map[string]func(map[string]interface{}) (interface{}, error)
}

type stubToolCall struct {
	RuntimeSessionID string
	ToolName         string
	Args             map[string]interface{}
}

func (b *stubBackend) Start(context.Context) error { return nil }

func (b *stubBackend) Close() {}

func (b *stubBackend) Exposures() []vfs.Exposure {
	out := make([]vfs.Exposure, len(b.exposures))
	copy(out, b.exposures)
	return out
}

func (b *stubBackend) CallTool(
	ctx context.Context,
	_ string,
	toolName string,
	args map[string]interface{},
) (interface{}, error) {
	clonedArgs := make(map[string]interface{}, len(args))
	for key, value := range args {
		clonedArgs[key] = value
	}
	b.calls = append(b.calls, stubToolCall{
		RuntimeSessionID: runtimeauth.RuntimeSessionIDFromContext(ctx),
		ToolName:         toolName,
		Args:             clonedArgs,
	})
	handler := b.handlers[toolName]
	if handler == nil {
		return nil, fmt.Errorf("unexpected tool call %q", toolName)
	}
	return handler(args)
}

func (b *stubBackend) OpenRuntimeSession(context.Context, string, string) error { return nil }

func (b *stubBackend) CloseRuntimeSession(context.Context, string) error { return nil }

func TestGetattrSizesDynamicBrowserFile(t *testing.T) {
	backend := &stubBackend{
		exposures: []vfs.Exposure{
			{Capability: "browser", StableKey: "demo", Name: "demo"},
		},
		handlers: map[string]func(map[string]interface{}) (interface{}, error){
			"list_pages": func(map[string]interface{}) (interface{}, error) {
				return stubResult("Listed pages.", map[string]interface{}{
					"selectedPageId": 7,
					"pages": []map[string]interface{}{
						{"pageId": 7, "title": "Home"},
					},
				}), nil
			},
		},
	}

	service := vfs.NewWithBackend(relaypaths.ResolvedPaths{}, backend)
	if err := service.Start(context.Background()); err != nil {
		t.Fatalf("service.Start() error: %v", err)
	}
	defer service.Close()

	fs := New(service)
	path := "/browser/demo/sessions/default/pages/list.json"

	var stat fuse.Stat_t
	if got := fs.Getattr(path, &stat, 0); got != 0 {
		t.Fatalf("Getattr() = %d, want 0", got)
	}
	if stat.Size <= 0 {
		t.Fatalf("Getattr() size = %d, want > 0", stat.Size)
	}

	errno, fh := fs.Open(path, fuse.O_RDONLY)
	if errno != 0 {
		t.Fatalf("Open() = %d, want 0", errno)
	}
	defer fs.Release(path, fh)

	buf := make([]byte, stat.Size)
	n := fs.Read(path, buf, 0, fh)
	if n <= 0 {
		t.Fatalf("Read() = %d, want > 0", n)
	}
	output := string(buf[:n])
	if !strings.Contains(output, "\"pageId\": 7") {
		t.Fatalf("Read() output = %q, want pageId JSON", output)
	}

	if len(backend.calls) != 2 {
		t.Fatalf("tool calls = %d, want 2 (Getattr + Open prefetch)", len(backend.calls))
	}
}

func TestGetattrReturnsReadErrorsForDynamicFiles(t *testing.T) {
	backend := &stubBackend{
		exposures: []vfs.Exposure{
			{Capability: "browser", StableKey: "demo", Name: "demo"},
		},
		handlers: map[string]func(map[string]interface{}) (interface{}, error){
			"list_pages": func(map[string]interface{}) (interface{}, error) {
				return nil, fmt.Errorf("backend unavailable")
			},
		},
	}

	service := vfs.NewWithBackend(relaypaths.ResolvedPaths{}, backend)
	if err := service.Start(context.Background()); err != nil {
		t.Fatalf("service.Start() error: %v", err)
	}
	defer service.Close()

	fs := New(service)
	var stat fuse.Stat_t
	if got := fs.Getattr("/browser/demo/sessions/default/pages/list.json", &stat, 0); got != -fuse.EIO {
		t.Fatalf("Getattr() = %d, want %d", got, -fuse.EIO)
	}
}

func TestGetattrAllowsWritableControlFilesWithoutReadBack(t *testing.T) {
	backend := &stubBackend{
		exposures: []vfs.Exposure{
			{Capability: "browser", StableKey: "demo", Name: "demo"},
		},
		handlers: map[string]func(map[string]interface{}) (interface{}, error){},
	}

	service := vfs.NewWithBackend(relaypaths.ResolvedPaths{}, backend)
	if err := service.Start(context.Background()); err != nil {
		t.Fatalf("service.Start() error: %v", err)
	}
	defer service.Close()

	fs := New(service)
	var stat fuse.Stat_t
	if got := fs.Getattr("/browser/demo/sessions/default/actions/new_page", &stat, 0); got != 0 {
		t.Fatalf("Getattr() = %d, want 0", got)
	}
	if stat.Size != 0 {
		t.Fatalf("Getattr() size = %d, want 0 for writable control file", stat.Size)
	}
}

func stubResult(text string, structured interface{}) interface{} {
	result := map[string]interface{}{
		"isError": false,
		"content": []map[string]interface{}{
			{
				"type": "text",
				"text": text,
			},
		},
	}
	if structured != nil {
		result["structuredContent"] = structured
	}
	return result
}
