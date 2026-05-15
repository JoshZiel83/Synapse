package vfs

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

var (
	browserSnapshotUIDPattern    = regexp.MustCompile(`(?:^|[\s\[])uid=([^\]\s]+)`)
	browserSnapshotQuotedPattern = regexp.MustCompile(`"([^"]+)"`)
)

type browserTree struct {
	SelectedPageID int               `json:"selectedPageId,omitempty"`
	Backend        string            `json:"backend,omitempty"`
	Source         string            `json:"source,omitempty"`
	Title          string            `json:"title,omitempty"`
	URL            string            `json:"url,omitempty"`
	NodeCount      int               `json:"nodeCount"`
	UIDNodeCount   int               `json:"uidNodeCount"`
	Truncated      bool              `json:"truncated,omitempty"`
	RootIDs        []string          `json:"rootIds"`
	Nodes          []browserTreeNode `json:"nodes"`

	byID map[string]*browserTreeNode `json:"-"`
}

type browserTreeNode struct {
	ID         string            `json:"id"`
	PathID     string            `json:"pathId"`
	UID        string            `json:"uid,omitempty"`
	NodeType   string            `json:"nodeType,omitempty"`
	Tag        string            `json:"tag,omitempty"`
	ParentID   string            `json:"parentId,omitempty"`
	Depth      int               `json:"depth"`
	Role       string            `json:"role,omitempty"`
	Name       string            `json:"name,omitempty"`
	Text       string            `json:"text,omitempty"`
	Attributes map[string]string `json:"attributes,omitempty"`
	Summary    string            `json:"summary"`
	Line       string            `json:"line"`
	Synthetic  bool              `json:"synthetic,omitempty"`
	ChildIDs   []string          `json:"childIds,omitempty"`
	Actions    []string          `json:"actions,omitempty"`
}

type browserTreeStackEntry struct {
	id     string
	indent int
}

func (s *Service) browserSnapshotText(
	exposure Exposure,
	session *SessionState,
) (string, error) {
	result, err := s.callBrowserTool(context.Background(), exposure.StableKey, session, "take_snapshot", nil)
	if err != nil {
		return "", err
	}
	text := strings.TrimRight(result.Text(), "\r\n")
	if strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("browser snapshot did not include text content")
	}
	return text, nil
}

func (s *Service) browserTree(
	exposure Exposure,
	session *SessionState,
) (*browserTree, error) {
	tree, err := s.browserDOMTree(exposure, session)
	if err == nil {
		return tree, nil
	}
	snapshot, err := s.browserSnapshotText(exposure, session)
	if err != nil {
		return nil, err
	}
	tree = parseBrowserSnapshotTree(snapshot, session.SelectedPageID)
	tree.Backend = "a11y_snapshot"
	tree.Source = "take_snapshot"
	return tree, nil
}

func parseBrowserSnapshotTree(snapshot string, selectedPageID int) *browserTree {
	tree := &browserTree{
		SelectedPageID: selectedPageID,
		RootIDs:        []string{},
		Nodes:          []browserTreeNode{},
	}
	counts := make(map[string]int)
	indexByID := make(map[string]int)
	stack := make([]browserTreeStackEntry, 0, 16)

	for lineNumber, rawLine := range strings.Split(snapshot, "\n") {
		line := strings.TrimRight(rawLine, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}

		indent, content := browserSnapshotIndentAndContent(line)
		if content == "" {
			continue
		}
		for len(stack) > 0 && indent <= stack[len(stack)-1].indent {
			stack = stack[:len(stack)-1]
		}

		uid := browserSnapshotUID(content)
		baseID := uid
		synthetic := false
		if baseID == "" {
			baseID = fmt.Sprintf("line-%03d", lineNumber+1)
			synthetic = true
		}
		id := uniqueBrowserTreeNodeID(baseID, counts)

		node := browserTreeNode{
			ID:        id,
			PathID:    browserTreePathID(id),
			UID:       uid,
			Depth:     len(stack),
			Role:      browserSnapshotRole(content),
			Name:      browserSnapshotName(content),
			Summary:   content,
			Line:      content,
			Synthetic: synthetic,
		}
		if len(stack) > 0 {
			node.ParentID = stack[len(stack)-1].id
		} else {
			tree.RootIDs = append(tree.RootIDs, id)
		}
		if node.UID != "" {
			node.Actions = append(node.Actions, "click")
			if browserNodeSupportsFill(node.Role) {
				node.Actions = append(node.Actions, "fill")
			}
		}

		tree.Nodes = append(tree.Nodes, node)
		nodeIndex := len(tree.Nodes) - 1
		indexByID[id] = nodeIndex
		if node.ParentID != "" {
			parentIndex := indexByID[node.ParentID]
			tree.Nodes[parentIndex].ChildIDs = append(tree.Nodes[parentIndex].ChildIDs, id)
		}
		stack = append(stack, browserTreeStackEntry{id: id, indent: indent})
	}

	tree.index()
	return tree
}

func (tree *browserTree) index() {
	tree.byID = make(map[string]*browserTreeNode, len(tree.Nodes))
	tree.NodeCount = len(tree.Nodes)
	tree.UIDNodeCount = 0
	for i := range tree.Nodes {
		node := &tree.Nodes[i]
		if node.PathID == "" {
			node.PathID = browserTreePathID(node.ID)
		}
		tree.byID[node.ID] = node
		if node.UID != "" {
			tree.UIDNodeCount++
		}
	}
}

func (tree *browserTree) nodeBySegment(segment string) (*browserTreeNode, error) {
	nodeID, err := url.PathUnescape(segment)
	if err != nil {
		return nil, ErrNotFound
	}
	if tree.byID == nil {
		tree.index()
	}
	node, ok := tree.byID[nodeID]
	if !ok {
		return nil, ErrNotFound
	}
	return node, nil
}

func browserTreePathID(id string) string {
	return url.PathEscape(id)
}

func uniqueBrowserTreeNodeID(baseID string, counts map[string]int) string {
	counts[baseID]++
	if counts[baseID] == 1 {
		return baseID
	}
	return fmt.Sprintf("%s#%d", baseID, counts[baseID])
}

func browserSnapshotUID(content string) string {
	match := browserSnapshotUIDPattern.FindStringSubmatch(content)
	if len(match) < 2 {
		return ""
	}
	return strings.TrimSpace(match[1])
}

func browserSnapshotIndentAndContent(line string) (int, string) {
	indent := 0
	index := 0
	for index < len(line) {
		switch line[index] {
		case ' ':
			indent++
			index++
		case '\t':
			indent += 2
			index++
		default:
			goto done
		}
	}

done:
	content := strings.TrimSpace(line[index:])
	for {
		switch {
		case strings.HasPrefix(content, "- "):
			content = strings.TrimSpace(content[2:])
		case strings.HasPrefix(content, "* "):
			content = strings.TrimSpace(content[2:])
		case strings.HasPrefix(content, "• "):
			content = strings.TrimSpace(strings.TrimPrefix(content, "•"))
		default:
			return indent, content
		}
	}
}

func browserSnapshotRole(content string) string {
	clean := strings.TrimSpace(browserSnapshotUIDPattern.ReplaceAllString(content, ""))
	for strings.HasPrefix(clean, "[") {
		closing := strings.Index(clean, "]")
		if closing < 0 {
			break
		}
		clean = strings.TrimSpace(clean[closing+1:])
	}
	if clean == "" {
		return ""
	}

	end := len(clean)
	for i, r := range clean {
		if unicode.IsSpace(r) || r == '"' || r == '[' || r == '(' || r == ':' {
			end = i
			break
		}
	}
	return strings.TrimSpace(clean[:end])
}

func browserSnapshotName(content string) string {
	matches := browserSnapshotQuotedPattern.FindAllStringSubmatch(content, -1)
	if len(matches) > 0 {
		names := make([]string, 0, len(matches))
		for _, match := range matches {
			if len(match) < 2 {
				continue
			}
			name := strings.TrimSpace(match[1])
			if name != "" {
				names = append(names, name)
			}
		}
		return strings.Join(names, " ")
	}

	clean := strings.TrimSpace(browserSnapshotUIDPattern.ReplaceAllString(content, ""))
	role := browserSnapshotRole(clean)
	if role != "" && strings.HasPrefix(clean, role) {
		clean = strings.TrimSpace(strings.TrimPrefix(clean, role))
	}
	clean = strings.TrimSpace(strings.Trim(clean, "[]()"))
	if clean == "" || strings.Contains(clean, "=") {
		return ""
	}
	return clean
}

func browserNodeSupportsFill(role string) bool {
	normalized := strings.ToLower(strings.TrimSpace(role))
	switch normalized {
	case "textbox", "searchbox", "combobox", "listbox", "textarea", "spinbutton", "textboxwithcombo":
		return true
	default:
		return false
	}
}

func browserNodeHasAction(node *browserTreeNode, action string) bool {
	for _, candidate := range node.Actions {
		if candidate == action {
			return true
		}
	}
	return false
}

func renderBrowserTree(tree *browserTree) string {
	if tree == nil || len(tree.Nodes) == 0 {
		return ""
	}
	lines := make([]string, 0, len(tree.Nodes))
	for _, node := range tree.Nodes {
		line := strings.TrimSpace(node.Line)
		if line == "" {
			line = strings.TrimSpace(node.Summary)
		}
		if line == "" {
			line = node.ID
		}
		lines = append(lines, strings.Repeat("  ", node.Depth)+line)
	}
	return strings.Join(lines, "\n")
}
