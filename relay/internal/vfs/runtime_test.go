package vfs

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"

	cuamcp "github.com/PekingSpades/Synapse/relay/internal/builtinmcp/cua"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
)

type stubToolCall struct {
	RuntimeSessionID  string
	ExposureStableKey string
	ToolName          string
	Args              map[string]interface{}
}

type stubBackend struct {
	exposures             []Exposure
	calls                 []stubToolCall
	openedRuntimeSessions []string
	closedRuntimeSessions []string
	handlers              map[string]func(map[string]interface{}) (interface{}, error)
}

type stubCUASemanticProvider struct {
	tree *cuaSemanticTree
	err  error
}

func (b *stubBackend) Start(context.Context) error { return nil }

func (b *stubBackend) Close() {}

func (b *stubBackend) Exposures() []Exposure {
	out := make([]Exposure, len(b.exposures))
	copy(out, b.exposures)
	return out
}

func (b *stubBackend) CallTool(
	ctx context.Context,
	exposureStableKey string,
	toolName string,
	args map[string]interface{},
) (interface{}, error) {
	clone := map[string]interface{}{}
	for key, value := range args {
		clone[key] = value
	}
	b.calls = append(b.calls, stubToolCall{
		RuntimeSessionID:  runtimeauth.RuntimeSessionIDFromContext(ctx),
		ExposureStableKey: exposureStableKey,
		ToolName:          toolName,
		Args:              clone,
	})
	handler, ok := b.handlers[toolName]
	if !ok {
		return nil, fmt.Errorf("unexpected tool call %q", toolName)
	}
	return handler(args)
}

func (b *stubBackend) OpenRuntimeSession(_ context.Context, _ string, runtimeSessionID string) error {
	b.openedRuntimeSessions = append(b.openedRuntimeSessions, runtimeSessionID)
	return nil
}

func (b *stubBackend) CloseRuntimeSession(_ context.Context, runtimeSessionID string) error {
	b.closedRuntimeSessions = append(b.closedRuntimeSessions, runtimeSessionID)
	return nil
}

func (p *stubCUASemanticProvider) Snapshot(context.Context) (*cuaSemanticTree, error) {
	return p.tree, p.err
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

func entryNames(entries []Entry) []string {
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name)
	}
	sort.Strings(names)
	return names
}

func hasEntryName(entries []Entry, name string) bool {
	for _, entry := range entries {
		if entry.Name == name {
			return true
		}
	}
	return false
}

func TestBrowserTreeProjectionAndNodeAction(t *testing.T) {
	backend := &stubBackend{
		exposures: []Exposure{
			{Capability: "browser", StableKey: "demo", Name: "demo"},
		},
		handlers: map[string]func(map[string]interface{}) (interface{}, error){
			"take_snapshot": func(map[string]interface{}) (interface{}, error) {
				return stubResult("Snapshot ready.", nil), nil
			},
			"evaluate_script": func(args map[string]interface{}) (interface{}, error) {
				fn, _ := args["function"].(string)
				if strings.Contains(fn, "const maxNodes =") {
					return stubResult("Serialized DOM.", map[string]interface{}{
						"backend": "dom",
						"title":   "Example App",
						"url":     "https://example.com",
						"rootIds": []string{"root"},
						"nodes": []map[string]interface{}{
							{
								"id":       "root",
								"depth":    0,
								"nodeType": "element",
								"tag":      "html",
								"role":     "html",
								"summary":  "<html>",
								"line":     "<html>",
								"childIds": []string{"0"},
							},
							{
								"id":       "0",
								"parentId": "root",
								"depth":    1,
								"nodeType": "element",
								"tag":      "input",
								"role":     "textbox",
								"name":     "Search",
								"text":     "",
								"summary":  "<input> [textbox] \"Search\"",
								"line":     "<input> [textbox] \"Search\"",
								"actions":  []string{"click", "fill"},
							},
						},
					}), nil
				}
				if !strings.Contains(fn, `"needle"`) {
					return nil, fmt.Errorf("evaluate_script function = %q, want embedded fill value", fn)
				}
				return stubResult("Filled.", map[string]interface{}{
					"id":    "0",
					"value": "needle",
				}), nil
			},
		},
	}

	service := NewWithBackend(relaypathsZero(), backend)
	if err := service.Start(context.Background()); err != nil {
		t.Fatalf("service.Start() error: %v", err)
	}
	defer service.Close()

	treeEntries, err := service.List("/browser/demo/sessions/default/tree")
	if err != nil {
		t.Fatalf("service.List(tree) error: %v", err)
	}
	if got, want := entryNames(treeEntries), []string{"index.json", "nodes", "snapshot.txt"}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("tree entry names = %v, want %v", got, want)
	}

	nodeEntries, err := service.List("/browser/demo/sessions/default/tree/nodes")
	if err != nil {
		t.Fatalf("service.List(tree/nodes) error: %v", err)
	}
	if !hasEntryName(nodeEntries, "list.json") || !hasEntryName(nodeEntries, "root") || !hasEntryName(nodeEntries, "0") {
		t.Fatalf("tree node entries = %v, want list.json plus root and 0 nodes", entryNames(nodeEntries))
	}

	readResult, err := service.Read("/browser/demo/sessions/default/tree/nodes/0/node.json")
	if err != nil {
		t.Fatalf("service.Read(node.json) error: %v", err)
	}
	var node browserTreeNode
	if err := json.Unmarshal(readResult.Data, &node); err != nil {
		t.Fatalf("unmarshal node.json: %v", err)
	}
	if node.ID != "0" || node.Tag != "input" {
		t.Fatalf("node = %+v, want DOM input node 0", node)
	}
	if !browserNodeHasAction(&node, "fill") {
		t.Fatalf("node actions = %v, expected fill", node.Actions)
	}

	if _, err := service.Write("/browser/demo/sessions/default/tree/nodes/0/actions/fill", []byte("needle")); err != nil {
		t.Fatalf("service.Write(fill) error: %v", err)
	}
	last := backend.calls[len(backend.calls)-1]
	if last.ToolName != "evaluate_script" {
		t.Fatalf("last tool = %q, want evaluate_script", last.ToolName)
	}
	fn, _ := last.Args["function"].(string)
	if !strings.Contains(fn, `const pathText = "0";`) || !strings.Contains(fn, `const valueText = "needle";`) {
		t.Fatalf("fill function = %q, want embedded path/value literals", fn)
	}
	if got := last.RuntimeSessionID; got != "relayfs:browser:demo:default" {
		t.Fatalf("runtime session id = %q, want relayfs:browser:demo:default", got)
	}
}

func TestBrowserPlainTextNewPageAction(t *testing.T) {
	backend := &stubBackend{
		exposures: []Exposure{
			{Capability: "browser", StableKey: "demo", Name: "demo"},
		},
		handlers: map[string]func(map[string]interface{}) (interface{}, error){
			"new_page": func(args map[string]interface{}) (interface{}, error) {
				return stubResult("Opened page.", map[string]interface{}{
					"url": args["url"],
				}), nil
			},
			"list_pages": func(map[string]interface{}) (interface{}, error) {
				return stubResult("Listed pages.", map[string]interface{}{
					"selectedPageId": 7,
					"pages": []map[string]interface{}{
						{"pageId": 2, "title": "Old"},
						{"pageId": 7, "title": "New"},
					},
				}), nil
			},
		},
	}

	service := NewWithBackend(relaypathsZero(), backend)
	if err := service.Start(context.Background()); err != nil {
		t.Fatalf("service.Start() error: %v", err)
	}
	defer service.Close()

	if _, err := service.Write("/browser/demo/sessions/default/actions/new_page", []byte("https://example.com")); err != nil {
		t.Fatalf("service.Write(new_page) error: %v", err)
	}
	if len(backend.calls) < 2 {
		t.Fatalf("browser calls = %v, want new_page followed by list_pages", backend.calls)
	}
	first := backend.calls[0]
	if first.ToolName != "new_page" {
		t.Fatalf("first tool = %q, want new_page", first.ToolName)
	}
	if got := first.Args["url"]; got != "https://example.com" {
		t.Fatalf("new_page url = %v, want https://example.com", got)
	}
	if backend.calls[1].ToolName != "list_pages" {
		t.Fatalf("second tool = %q, want list_pages", backend.calls[1].ToolName)
	}
	stateResult, err := service.Read("/browser/demo/sessions/default/state.json")
	if err != nil {
		t.Fatalf("service.Read(state.json) error: %v", err)
	}
	var state SessionState
	if err := json.Unmarshal(stateResult.Data, &state); err != nil {
		t.Fatalf("unmarshal state: %v", err)
	}
	if state.SelectedPageID != 7 {
		t.Fatalf("selected page id = %d, want 7", state.SelectedPageID)
	}
}

func TestBrowserExtractSelectedPageIDFromListText(t *testing.T) {
	result, err := decodeToolResult(map[string]interface{}{
		"isError": false,
		"content": []map[string]interface{}{
			{
				"type": "text",
				"text": stringsJoinLines(
					"## Pages",
					"1: about:blank",
					"2: https://example.com [selected]",
				),
			},
		},
	})
	if err != nil {
		t.Fatalf("decodeToolResult() error: %v", err)
	}

	pageID, ok := browserExtractSelectedPageID(result)
	if !ok {
		t.Fatalf("browserExtractSelectedPageID() = not found, want 2")
	}
	if pageID != 2 {
		t.Fatalf("browserExtractSelectedPageID() = %d, want 2", pageID)
	}
}

func TestBrowserTreeParsesEvaluateScriptTextResult(t *testing.T) {
	backend := &stubBackend{
		exposures: []Exposure{
			{Capability: "browser", StableKey: "demo", Name: "demo"},
		},
		handlers: map[string]func(map[string]interface{}) (interface{}, error){
			"take_snapshot": func(map[string]interface{}) (interface{}, error) {
				return stubResult("Snapshot ready.", nil), nil
			},
			"evaluate_script": func(map[string]interface{}) (interface{}, error) {
				return stubResult(stringsJoinLines(
					"Script ran on page and returned:",
					"```json",
					`{"backend":"dom","title":"Example App","url":"https://example.com","rootIds":["root"],"nodes":[{"id":"root","nodeType":"element","tag":"html","role":"html","summary":"<html>","line":"<html>"}]}`,
					"```",
				), nil), nil
			},
		},
	}

	service := NewWithBackend(relaypathsZero(), backend)
	if err := service.Start(context.Background()); err != nil {
		t.Fatalf("service.Start() error: %v", err)
	}
	defer service.Close()

	readResult, err := service.Read("/browser/demo/sessions/default/tree/index.json")
	if err != nil {
		t.Fatalf("service.Read(tree/index.json) error: %v", err)
	}
	var tree browserTree
	if err := json.Unmarshal(readResult.Data, &tree); err != nil {
		t.Fatalf("unmarshal tree index: %v", err)
	}
	if tree.Backend != "dom" {
		t.Fatalf("tree backend = %q, want dom", tree.Backend)
	}
	if tree.Source != "evaluate_script" {
		t.Fatalf("tree source = %q, want evaluate_script", tree.Source)
	}
	if tree.NodeCount != 1 || len(tree.Nodes) != 1 || tree.Nodes[0].Tag != "html" {
		t.Fatalf("tree = %+v, want parsed DOM node", tree)
	}
}

func TestCUATreeProjectionAndPlainTextAction(t *testing.T) {
	displays := []cuamcp.DisplayInfo{
		{
			ID:            1,
			Index:         0,
			IsMain:        true,
			ContainsMouse: true,
			Origin:        cuamcp.Rect{X: 0, Y: 0, W: 0, H: 0},
			Size:          cuamcp.Size{W: 1920, H: 1080},
			Scale:         1,
		},
	}
	windows := []cuamcp.WindowInfo{
		{
			ID:        42,
			PID:       99,
			Title:     "Demo Window",
			Bounds:    cuamcp.Rect{X: 10, Y: 20, W: 800, H: 600},
			IsVisible: true,
			Displays: []cuamcp.WindowDisplayRegion{
				{DisplayIndex: 0, DisplayID: 1, Rect: cuamcp.Rect{X: 10, Y: 20, W: 800, H: 600}},
			},
		},
	}

	backend := &stubBackend{
		exposures: []Exposure{
			{Capability: "cua", StableKey: "desk", Name: "desk"},
		},
		handlers: map[string]func(map[string]interface{}) (interface{}, error){
			"desktop_list_displays": func(map[string]interface{}) (interface{}, error) {
				return stubResult("Detected 1 display.", map[string]interface{}{"displays": displays}), nil
			},
			"desktop_list_windows": func(map[string]interface{}) (interface{}, error) {
				return stubResult("Listed 1 window.", map[string]interface{}{"windows": windows}), nil
			},
			"desktop_type_text": func(args map[string]interface{}) (interface{}, error) {
				return stubResult("Typed text.", map[string]interface{}{"text": args["text"]}), nil
			},
		},
	}

	service := NewWithBackend(relaypathsZero(), backend)
	if err := service.Start(context.Background()); err != nil {
		t.Fatalf("service.Start() error: %v", err)
	}
	defer service.Close()

	service.cuaTree = &stubCUASemanticProvider{
		tree: &cuaSemanticTree{
			Supported:   true,
			Backend:     "uia",
			AppName:     "Demo App",
			WindowTitle: "Demo Window",
			ProcessID:   99,
			FocusedID:   "root.0",
			RootIDs:     []string{"root"},
			Nodes: []cuaSemanticNode{
				{
					ID:       "root",
					Depth:    0,
					Role:     "window",
					Name:     "Demo Window",
					Bounds:   cuamcp.Rect{X: 10, Y: 20, W: 800, H: 600},
					ChildIDs: []string{"root.0"},
				},
				{
					ID:       "root.0",
					ParentID: "root",
					Depth:    1,
					Role:     "textbox",
					Name:     "Search",
					Bounds:   cuamcp.Rect{X: 110, Y: 120, W: 300, H: 40},
					State:    []string{"focused", "enabled"},
					Actions:  []string{"click", "type_text"},
				},
			},
		},
	}

	displayEntries, err := service.List("/cua/desk/sessions/default/tree/nodes")
	if err != nil {
		t.Fatalf("service.List(tree/nodes) error: %v", err)
	}
	if got := entryNames(displayEntries); len(got) != 3 || got[0] != "list.json" || got[1] != "root" || got[2] != "root.0" {
		t.Fatalf("tree node entries = %v, want [list.json root root.0]", got)
	}

	rootResult, err := service.Read("/cua/desk/sessions/default/tree/root.json")
	if err != nil {
		t.Fatalf("service.Read(tree/root.json) error: %v", err)
	}
	var root cuaTreeRoot
	if err := json.Unmarshal(rootResult.Data, &root); err != nil {
		t.Fatalf("unmarshal tree root: %v", err)
	}
	if !root.Supported || root.FocusedID != "root.0" || root.NodeCount != 2 {
		t.Fatalf("tree root = %+v, want supported semantic root with focused root.0", root)
	}

	focusedResult, err := service.Read("/cua/desk/sessions/default/focused/props.json")
	if err != nil {
		t.Fatalf("service.Read(focused/props.json) error: %v", err)
	}
	var focused cuaFocusedProps
	if err := json.Unmarshal(focusedResult.Data, &focused); err != nil {
		t.Fatalf("unmarshal focused props: %v", err)
	}
	if !focused.Supported {
		t.Fatalf("focused supported = false, want true")
	}
	if focused.FocusedNode == nil || focused.FocusedNode.ID != "root.0" {
		t.Fatalf("focused node = %+v, want root.0", focused.FocusedNode)
	}

	if _, err := service.Write("/cua/desk/sessions/default/tree/nodes/root.0/actions/type_text", []byte("hello desktop")); err != nil {
		t.Fatalf("service.Write(tree type_text) error: %v", err)
	}
	last := backend.calls[len(backend.calls)-1]
	if last.ToolName != "desktop_type_text" {
		t.Fatalf("last tool = %q, want desktop_type_text", last.ToolName)
	}
	if got := last.Args["text"]; got != "hello desktop" {
		t.Fatalf("type_text payload = %v, want hello desktop", got)
	}
	if displaySelector, ok := last.Args["display"].(map[string]interface{}); !ok || displaySelector["id"] != float64(1) && displaySelector["id"] != 1 {
		t.Fatalf("display selector = %v, want display id 1", last.Args["display"])
	}
	if got := last.RuntimeSessionID; got != "relayfs:cua:desk:default" {
		t.Fatalf("runtime session id = %q, want relayfs:cua:desk:default", got)
	}
}

func TestCUAPressKeysPlainTextAction(t *testing.T) {
	backend := &stubBackend{
		exposures: []Exposure{
			{Capability: "cua", StableKey: "desk", Name: "desk"},
		},
		handlers: map[string]func(map[string]interface{}) (interface{}, error){
			"desktop_press_keys": func(args map[string]interface{}) (interface{}, error) {
				return stubResult("Pressed keys.", args), nil
			},
		},
	}

	service := NewWithBackend(relaypathsZero(), backend)
	if err := service.Start(context.Background()); err != nil {
		t.Fatalf("service.Start() error: %v", err)
	}
	defer service.Close()

	if _, err := service.Write("/cua/desk/sessions/default/actions/press_keys", []byte("ctrl+l\nenter")); err != nil {
		t.Fatalf("service.Write(press_keys) error: %v", err)
	}
	last := backend.calls[len(backend.calls)-1]
	if last.ToolName != "desktop_press_keys" {
		t.Fatalf("last tool = %q, want desktop_press_keys", last.ToolName)
	}
	sequence, ok := last.Args["sequence"].([][]string)
	if ok {
		if fmt.Sprint(sequence) != fmt.Sprint([][]string{{"ctrl", "l"}, {"enter"}}) {
			t.Fatalf("press_keys sequence = %v, want [[ctrl l] [enter]]", sequence)
		}
		return
	}
	rawSequence, ok := last.Args["sequence"].([]interface{})
	if !ok {
		t.Fatalf("press_keys payload = %v, want sequence", last.Args)
	}
	if len(rawSequence) != 2 {
		t.Fatalf("press_keys sequence len = %d, want 2", len(rawSequence))
	}
}

func TestSessionCreateAndCloseControlFiles(t *testing.T) {
	backend := &stubBackend{
		exposures: []Exposure{
			{Capability: "browser", StableKey: "demo", Name: "demo"},
		},
		handlers: map[string]func(map[string]interface{}) (interface{}, error){},
	}

	service := NewWithBackend(relaypathsZero(), backend)
	if err := service.Start(context.Background()); err != nil {
		t.Fatalf("service.Start() error: %v", err)
	}
	defer service.Close()

	createResult, err := service.Write("/browser/demo/sessions/create", []byte("alpha_1"))
	if err != nil {
		t.Fatalf("service.Write(sessions/create) error: %v", err)
	}
	var createPayload map[string]interface{}
	if err := json.Unmarshal(createResult.Data, &createPayload); err != nil {
		t.Fatalf("unmarshal create payload: %v", err)
	}
	if got := createPayload["sessionId"]; got != "alpha_1" {
		t.Fatalf("created session id = %v, want alpha_1", got)
	}

	sessionEntries, err := service.List("/browser/demo/sessions")
	if err != nil {
		t.Fatalf("service.List(sessions) error: %v", err)
	}
	if !hasEntryName(sessionEntries, "create") || !hasEntryName(sessionEntries, "alpha_1") || !hasEntryName(sessionEntries, "default") {
		t.Fatalf("session entries = %v, want create/default/alpha_1", entryNames(sessionEntries))
	}
	if len(backend.openedRuntimeSessions) == 0 || backend.openedRuntimeSessions[len(backend.openedRuntimeSessions)-1] != "relayfs:browser:demo:alpha_1" {
		t.Fatalf("opened runtime sessions = %v, want relayfs:browser:demo:alpha_1", backend.openedRuntimeSessions)
	}

	if _, err := service.Write("/browser/demo/sessions/alpha_1/close", []byte("close")); err != nil {
		t.Fatalf("service.Write(close) error: %v", err)
	}
	if len(backend.closedRuntimeSessions) == 0 || backend.closedRuntimeSessions[len(backend.closedRuntimeSessions)-1] != "relayfs:browser:demo:alpha_1" {
		t.Fatalf("closed runtime sessions = %v, want relayfs:browser:demo:alpha_1", backend.closedRuntimeSessions)
	}

	sessionEntries, err = service.List("/browser/demo/sessions")
	if err != nil {
		t.Fatalf("service.List(sessions after close) error: %v", err)
	}
	if hasEntryName(sessionEntries, "alpha_1") {
		t.Fatalf("session entries after close = %v, alpha_1 should be removed", entryNames(sessionEntries))
	}
}

func relaypathsZero() relaypaths.ResolvedPaths {
	return relaypaths.ResolvedPaths{}
}

func stringsJoinLines(lines ...string) string {
	return fmt.Sprintf("%s\n", strings.TrimSuffix(strings.Join(lines, "\n"), "\n"))
}
