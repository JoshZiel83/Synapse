package vfs

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	cuamcp "github.com/PekingSpades/Synapse/relay/internal/builtinmcp/cua"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
)

type cuaSemanticProvider interface {
	Snapshot(context.Context) (*cuaSemanticTree, error)
}

type cuaSemanticTree struct {
	Supported   bool              `json:"supported"`
	Backend     string            `json:"backend,omitempty"`
	Message     string            `json:"message,omitempty"`
	AppName     string            `json:"appName,omitempty"`
	WindowTitle string            `json:"windowTitle,omitempty"`
	ProcessID   int               `json:"processId,omitempty"`
	NodeCount   int               `json:"nodeCount"`
	FocusedID   string            `json:"focusedId,omitempty"`
	RootIDs     []string          `json:"rootIds"`
	Nodes       []cuaSemanticNode `json:"nodes"`

	byID map[string]*cuaSemanticNode `json:"-"`
}

type cuaSemanticNode struct {
	ID          string            `json:"id"`
	PathID      string            `json:"pathId,omitempty"`
	ParentID    string            `json:"parentId,omitempty"`
	Depth       int               `json:"depth"`
	Role        string            `json:"role,omitempty"`
	Name        string            `json:"name,omitempty"`
	Description string            `json:"description,omitempty"`
	Value       string            `json:"value,omitempty"`
	Text        string            `json:"text,omitempty"`
	Bounds      cuamcp.Rect       `json:"bounds"`
	State       []string          `json:"state,omitempty"`
	Attributes  map[string]string `json:"attributes,omitempty"`
	AppName     string            `json:"appName,omitempty"`
	WindowTitle string            `json:"windowTitle,omitempty"`
	ProcessID   int               `json:"processId,omitempty"`
	Summary     string            `json:"summary,omitempty"`
	ChildIDs    []string          `json:"childIds,omitempty"`
	Actions     []string          `json:"actions,omitempty"`
}

func (tree *cuaSemanticTree) index() {
	tree.byID = make(map[string]*cuaSemanticNode, len(tree.Nodes))
	tree.NodeCount = len(tree.Nodes)
	for i := range tree.Nodes {
		node := &tree.Nodes[i]
		if node.PathID == "" {
			node.PathID = cuaSemanticPathID(node.ID)
		}
		if node.Summary == "" {
			node.Summary = cuaSemanticNodeSummary(node)
		}
		if len(node.Actions) == 0 {
			node.Actions = cuaSemanticNodeActions(node)
		}
		tree.byID[node.ID] = node
	}
}

func (tree *cuaSemanticTree) nodeBySegment(segment string) (*cuaSemanticNode, error) {
	if tree.byID == nil {
		tree.index()
	}
	id, err := url.PathUnescape(segment)
	if err != nil {
		return nil, ErrNotFound
	}
	node, ok := tree.byID[id]
	if !ok {
		return nil, ErrNotFound
	}
	return node, nil
}

func cuaSemanticPathID(id string) string {
	return url.PathEscape(id)
}

func cuaSemanticNodeSummary(node *cuaSemanticNode) string {
	if node == nil {
		return ""
	}
	parts := make([]string, 0, 4)
	if node.Role != "" {
		parts = append(parts, "["+strings.TrimSpace(node.Role)+"]")
	}
	if node.Name != "" {
		parts = append(parts, strconv.Quote(strings.TrimSpace(node.Name)))
	}
	if node.Value != "" && !strings.EqualFold(strings.TrimSpace(node.Value), strings.TrimSpace(node.Name)) {
		parts = append(parts, strconv.Quote(strings.TrimSpace(node.Value)))
	}
	if node.Description != "" {
		parts = append(parts, strconv.Quote(strings.TrimSpace(node.Description)))
	}
	if len(parts) == 0 {
		return node.ID
	}
	return strings.Join(parts, " ")
}

func cuaSemanticNodeActions(node *cuaSemanticNode) []string {
	if node == nil {
		return nil
	}
	actions := make([]string, 0, 2)
	if node.Bounds.W > 0 && node.Bounds.H > 0 {
		actions = append(actions, "click")
	}
	role := strings.ToLower(strings.TrimSpace(node.Role))
	if role == "textbox" || role == "text" || role == "text field" || role == "entry" || role == "document text" || role == "editable text" || role == "search box" || role == "searchbox" || role == "combobox" {
		actions = append(actions, "type_text")
	}
	return actions
}

func cuaSemanticFocusNode(tree *cuaSemanticTree) *cuaSemanticNode {
	if tree == nil {
		return nil
	}
	if tree.byID == nil {
		tree.index()
	}
	if tree.FocusedID != "" {
		if node, ok := tree.byID[tree.FocusedID]; ok {
			return node
		}
	}
	for i := range tree.Nodes {
		node := &tree.Nodes[i]
		for _, state := range node.State {
			if strings.EqualFold(state, "focused") {
				return node
			}
		}
	}
	return nil
}

type scriptCUASemanticProvider struct {
	backend     string
	interpreter string
	args        []string
	extension   string
	script      string
	tempRoot    string
}

func (p *scriptCUASemanticProvider) Snapshot(ctx context.Context) (*cuaSemanticTree, error) {
	if strings.TrimSpace(p.script) == "" {
		return unsupportedCUASemanticTree(p.backend, "semantic accessibility backend is not configured"), nil
	}
	if strings.TrimSpace(p.interpreter) == "" {
		return unsupportedCUASemanticTree(p.backend, "semantic accessibility backend is not available in this build"), nil
	}

	scriptPath, cleanup, err := p.writeScript()
	if err != nil {
		return unsupportedCUASemanticTree(p.backend, err.Error()), nil
	}
	defer cleanup()

	args := append(append([]string(nil), p.args...), scriptPath)
	cmd := exec.CommandContext(ctx, p.interpreter, args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return unsupportedCUASemanticTree(p.backend, message), nil
	}

	payload := strings.TrimSpace(stdout.String())
	if payload == "" {
		return unsupportedCUASemanticTree(p.backend, "semantic accessibility backend returned an empty response"), nil
	}

	var tree cuaSemanticTree
	if err := json.Unmarshal([]byte(payload), &tree); err != nil {
		return unsupportedCUASemanticTree(p.backend, fmt.Sprintf("failed to decode semantic accessibility tree: %v", err)), nil
	}
	if tree.Backend == "" {
		tree.Backend = p.backend
	}
	tree.index()
	return &tree, nil
}

func (p *scriptCUASemanticProvider) writeScript() (string, func(), error) {
	dir := p.tempRoot
	if strings.TrimSpace(dir) == "" {
		dir = os.TempDir()
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", nil, err
	}

	pattern := "relay-cua-semantic-*"
	if ext := strings.TrimSpace(p.extension); ext != "" {
		pattern += ext
	}
	file, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", nil, err
	}
	if _, err := file.WriteString(p.script); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return "", nil, err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(file.Name())
		return "", nil, err
	}
	if err := os.Chmod(file.Name(), 0o700); err != nil {
		_ = os.Remove(file.Name())
		return "", nil, err
	}
	return file.Name(), func() {
		_ = os.Remove(file.Name())
	}, nil
}

func unsupportedCUASemanticTree(backend, message string) *cuaSemanticTree {
	tree := &cuaSemanticTree{
		Supported: false,
		Backend:   strings.TrimSpace(backend),
		Message:   strings.TrimSpace(message),
		RootIDs:   []string{},
		Nodes:     []cuaSemanticNode{},
	}
	tree.index()
	return tree
}

func snapshotCUASemanticTree(service *Service) *cuaSemanticTree {
	if service == nil || service.cuaTree == nil {
		return unsupportedCUASemanticTree("", "semantic accessibility backend is not configured")
	}
	tree, err := service.cuaTree.Snapshot(context.Background())
	if err != nil {
		return unsupportedCUASemanticTree("", err.Error())
	}
	if tree == nil {
		return unsupportedCUASemanticTree("", "semantic accessibility backend returned no snapshot")
	}
	if tree.byID == nil {
		tree.index()
	}
	return tree
}

func sortCUASemanticNodes(nodes []cuaSemanticNode) {
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Depth == nodes[j].Depth {
			return nodes[i].ID < nodes[j].ID
		}
		return nodes[i].Depth < nodes[j].Depth
	})
}

func semanticProviderTempRoot(paths relaypaths.ResolvedPaths) string {
	if root := strings.TrimSpace(paths.HostPaths.TempRoot); root != "" {
		return filepath.Join(root, "relay-vfs-semantic")
	}
	return filepath.Join(os.TempDir(), "relay-vfs-semantic")
}
