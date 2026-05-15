package vfs

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

const browserDOMMaxNodes = 4000

type browserDOMSnapshot struct {
	Backend   string            `json:"backend"`
	Title     string            `json:"title,omitempty"`
	URL       string            `json:"url,omitempty"`
	Truncated bool              `json:"truncated,omitempty"`
	RootIDs   []string          `json:"rootIds"`
	Nodes     []browserTreeNode `json:"nodes"`
}

func (s *Service) browserDOMTree(
	exposure Exposure,
	session *SessionState,
) (*browserTree, error) {
	if err := s.ensureBrowserScriptContext(exposure, session); err != nil {
		return nil, err
	}
	result, err := s.callBrowserTool(context.Background(), exposure.StableKey, session, "evaluate_script", map[string]interface{}{
		"function": browserDOMSnapshotFunction(browserDOMMaxNodes),
	})
	if err != nil {
		return nil, err
	}

	snapshot, err := decodeBrowserDOMSnapshot(result)
	if err != nil {
		return nil, err
	}

	tree := &browserTree{
		SelectedPageID: session.SelectedPageID,
		Backend:        "dom",
		Source:         "evaluate_script",
		Title:          snapshot.Title,
		URL:            snapshot.URL,
		Truncated:      snapshot.Truncated,
		RootIDs:        append([]string(nil), snapshot.RootIDs...),
		Nodes:          append([]browserTreeNode(nil), snapshot.Nodes...),
	}
	if snapshot.Backend != "" {
		tree.Backend = snapshot.Backend
	}

	for i := range tree.Nodes {
		node := &tree.Nodes[i]
		if node.ID == "" {
			return nil, fmt.Errorf("browser DOM tree returned a node without an id")
		}
		node.PathID = browserTreePathID(node.ID)
		if len(node.Actions) == 0 {
			node.Actions = browserDOMActions(node)
		}
		if node.Summary == "" {
			node.Summary = browserDOMNodeSummary(node)
		}
		if node.Line == "" {
			node.Line = node.Summary
		}
	}
	tree.index()
	return tree, nil
}

func browserDOMActions(node *browserTreeNode) []string {
	actions := make([]string, 0, 2)
	if browserDOMNodeSupportsClick(node) {
		actions = append(actions, "click")
	}
	if browserDOMNodeSupportsFill(node) {
		actions = append(actions, "fill")
	}
	return actions
}

func browserDOMNodeSupportsClick(node *browserTreeNode) bool {
	if node == nil || !strings.EqualFold(node.NodeType, "element") {
		return false
	}
	for _, action := range node.Actions {
		if action == "click" {
			return true
		}
	}
	normalizedRole := strings.ToLower(strings.TrimSpace(node.Role))
	normalizedTag := strings.ToLower(strings.TrimSpace(node.Tag))
	if normalizedRole == "button" || normalizedRole == "link" || normalizedRole == "checkbox" || normalizedRole == "menuitem" || normalizedRole == "tab" {
		return true
	}
	switch normalizedTag {
	case "a", "button", "summary", "option", "label":
		return true
	default:
		return false
	}
}

func browserDOMNodeSupportsFill(node *browserTreeNode) bool {
	if node == nil || !strings.EqualFold(node.NodeType, "element") {
		return false
	}
	if browserNodeSupportsFill(node.Role) {
		return true
	}
	normalizedTag := strings.ToLower(strings.TrimSpace(node.Tag))
	switch normalizedTag {
	case "input", "textarea", "select":
		return true
	default:
		return false
	}
}

func browserDOMNodeSummary(node *browserTreeNode) string {
	if node == nil {
		return ""
	}
	parts := make([]string, 0, 4)
	if node.Tag != "" {
		parts = append(parts, "<"+strings.ToLower(strings.TrimSpace(node.Tag))+">")
	} else if node.NodeType != "" {
		parts = append(parts, strings.ToLower(strings.TrimSpace(node.NodeType)))
	}
	if node.Role != "" && !strings.EqualFold(node.Role, node.Tag) {
		parts = append(parts, "["+strings.TrimSpace(node.Role)+"]")
	}
	if node.Name != "" {
		parts = append(parts, strconv.Quote(strings.TrimSpace(node.Name)))
	}
	if node.Text != "" && !strings.EqualFold(node.Text, node.Name) {
		parts = append(parts, strconv.Quote(strings.TrimSpace(node.Text)))
	}
	if len(parts) == 0 {
		return node.ID
	}
	return strings.Join(parts, " ")
}

func (s *Service) browserDOMNodeClick(
	exposure Exposure,
	session *SessionState,
	node *browserTreeNode,
) (WriteResult, error) {
	if err := s.ensureBrowserScriptContext(exposure, session); err != nil {
		return WriteResult{}, err
	}
	result, err := s.callBrowserTool(context.Background(), exposure.StableKey, session, "evaluate_script", map[string]interface{}{
		"function": browserDOMClickFunction(node.ID),
	})
	if err != nil {
		return WriteResult{}, err
	}
	envelope, err := resultEnvelope(result)
	if err != nil {
		return WriteResult{}, err
	}
	response, err := jsonBytes(envelope)
	if err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Data: response, MimeType: "application/json"}, nil
}

func (s *Service) browserDOMNodeFill(
	exposure Exposure,
	session *SessionState,
	node *browserTreeNode,
	data []byte,
) (WriteResult, error) {
	if err := s.ensureBrowserScriptContext(exposure, session); err != nil {
		return WriteResult{}, err
	}
	value, err := parseBrowserDOMValuePayload(data)
	if err != nil {
		return WriteResult{}, err
	}
	result, err := s.callBrowserTool(context.Background(), exposure.StableKey, session, "evaluate_script", map[string]interface{}{
		"function": browserDOMFillFunction(node.ID, value),
	})
	if err != nil {
		return WriteResult{}, err
	}
	envelope, err := resultEnvelope(result)
	if err != nil {
		return WriteResult{}, err
	}
	response, err := jsonBytes(envelope)
	if err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Data: response, MimeType: "application/json"}, nil
}

func parseBrowserDOMValuePayload(data []byte) (string, error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return "", nil
	}
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") || trimmed == "null" {
		var payload map[string]interface{}
		if err := json.Unmarshal(data, &payload); err != nil {
			return "", fmt.Errorf("browser DOM fill payload must be valid JSON or plain text: %w", err)
		}
		if payload == nil {
			return "", nil
		}
		raw, _ := payload["value"]
		value, ok := raw.(string)
		if !ok {
			return "", fmt.Errorf("browser DOM fill payload field \"value\" must be a string")
		}
		return value, nil
	}
	return trimmed, nil
}

func (s *Service) ensureBrowserScriptContext(exposure Exposure, session *SessionState) error {
	_, err := s.callBrowserTool(context.Background(), exposure.StableKey, session, "take_snapshot", nil)
	return err
}

func decodeBrowserDOMSnapshot(result *toolResult) (browserDOMSnapshot, error) {
	var snapshot browserDOMSnapshot
	if result == nil {
		return snapshot, fmt.Errorf("browser DOM tool result is empty")
	}
	if hasStructuredContent(result.StructuredContent) {
		if err := json.Unmarshal(result.StructuredContent, &snapshot); err == nil {
			return snapshot, nil
		}
	}

	text := strings.TrimSpace(result.Text())
	if text == "" {
		return snapshot, fmt.Errorf("browser DOM tool result does not include structured content")
	}

	candidates := []string{text}
	if fenced := extractJSONFence(text); fenced != "" {
		candidates = append([]string{fenced}, candidates...)
	}
	if inline := extractJSONObject(text); inline != "" && inline != text {
		candidates = append([]string{inline}, candidates...)
	}

	for _, candidate := range candidates {
		if err := json.Unmarshal([]byte(candidate), &snapshot); err == nil {
			return snapshot, nil
		}
	}
	return snapshot, fmt.Errorf("browser DOM tool result did not contain a decodable DOM snapshot")
}

func extractJSONFence(text string) string {
	start := strings.Index(text, "```")
	if start < 0 {
		return ""
	}
	rest := text[start+3:]
	if newline := strings.IndexByte(rest, '\n'); newline >= 0 {
		rest = rest[newline+1:]
	}
	end := strings.Index(rest, "```")
	if end < 0 {
		return ""
	}
	return strings.TrimSpace(rest[:end])
}

func extractJSONObject(text string) string {
	start := strings.IndexByte(text, '{')
	end := strings.LastIndexByte(text, '}')
	if start < 0 || end < 0 || end <= start {
		return ""
	}
	return strings.TrimSpace(text[start : end+1])
}

func browserDOMSnapshotFunction(maxNodes int) string {
	return fmt.Sprintf(`() => {
  const maxNodes = %d;
  const nodes = [];
  let truncated = false;

  const clip = (value, limit = 240) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!text) {
      return '';
    }
    return text.length > limit ? text.slice(0, limit) + '...' : text;
  };

  const nodeName = (node) => {
    if (!(node instanceof Element)) {
      return '';
    }
    const candidates = [
      node.getAttribute('aria-label'),
      node.getAttribute('name'),
      node.getAttribute('placeholder'),
      node.getAttribute('title'),
      node.getAttribute('alt'),
      node.getAttribute('value'),
      node.textContent
    ];
    for (const candidate of candidates) {
      const text = clip(candidate, 160);
      if (text) {
        return text;
      }
    }
    return '';
  };

  const attrs = (node) => {
    if (!(node instanceof Element)) {
      return {};
    }
    const names = ['id', 'class', 'name', 'type', 'role', 'aria-label', 'placeholder', 'href', 'src', 'alt', 'title', 'value'];
    const result = {};
    for (const name of names) {
      const value = node.getAttribute(name);
      if (value != null && String(value).trim() !== '') {
        result[name] = clip(value, 200);
      }
    }
    if (node.isContentEditable) {
      result.contenteditable = 'true';
    }
    return result;
  };

  const roleFor = (node) => {
    if (!(node instanceof Element)) {
      return '';
    }
    return clip(node.getAttribute('role') || node.tagName.toLowerCase(), 120);
  };

  const textFor = (node) => {
    if (node == null) {
      return '';
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return clip(node.textContent, 200);
    }
    if (!(node instanceof Element)) {
      return '';
    }
    if (typeof node.value === 'string' && clip(node.value, 200)) {
      return clip(node.value, 200);
    }
    return clip(node.textContent, 200);
  };

  const canClick = (node) => {
    if (!(node instanceof Element)) {
      return false;
    }
    const tag = node.tagName.toLowerCase();
    const role = (node.getAttribute('role') || '').toLowerCase();
    if (typeof node.onclick === 'function') {
      return true;
    }
    if (node.hasAttribute('href') || node.hasAttribute('tabindex')) {
      return true;
    }
    if (tag === 'a' || tag === 'button' || tag === 'summary' || tag === 'label' || tag === 'option') {
      return true;
    }
    return role === 'button' || role === 'link' || role === 'checkbox' || role === 'menuitem' || role === 'tab';
  };

  const canFill = (node) => {
    if (!(node instanceof Element)) {
      return false;
    }
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
      return true;
    }
    if (node instanceof HTMLInputElement) {
      const type = (node.type || 'text').toLowerCase();
      return type !== 'button' && type !== 'checkbox' && type !== 'color' && type !== 'file' && type !== 'hidden' && type !== 'image' && type !== 'radio' && type !== 'range' && type !== 'reset' && type !== 'submit';
    }
    return node.isContentEditable;
  };

  const lineFor = (node, tag, role, name, text) => {
    const parts = [];
    if (tag) {
      parts.push('<' + tag + '>');
    } else {
      parts.push(node.nodeType === Node.TEXT_NODE ? '#text' : 'node');
    }
    if (role && role !== tag) {
      parts.push('[' + role + ']');
    }
    if (name) {
      parts.push(JSON.stringify(name));
    }
    if (text && text !== name) {
      parts.push(JSON.stringify(text));
    }
    return parts.join(' ');
  };

  const serialize = (node, parentId, path, depth) => {
    if (!node) {
      return null;
    }
    if (nodes.length >= maxNodes) {
      truncated = true;
      return null;
    }
    if (node.nodeType === Node.COMMENT_NODE) {
      return null;
    }
    if (node.nodeType === Node.TEXT_NODE && !clip(node.textContent, 80)) {
      return null;
    }

    const id = path.length ? path.join('.') : 'root';
    const tag = node instanceof Element ? node.tagName.toLowerCase() : '';
    const role = roleFor(node);
    const name = nodeName(node);
    const text = textFor(node);
    const line = lineFor(node, tag, role, name, text);
    const actions = [];
    if (canClick(node)) {
      actions.push('click');
    }
    if (canFill(node)) {
      actions.push('fill');
    }

    const record = {
      id,
      parentId: parentId || '',
      depth,
      nodeType: node.nodeType === Node.TEXT_NODE ? 'text' : (node.nodeType === Node.ELEMENT_NODE ? 'element' : String(node.nodeType)),
      tag,
      role,
      name,
      text,
      attributes: attrs(node),
      summary: line,
      line,
      childIds: [],
      actions
    };
    nodes.push(record);

    const currentId = id;
    if (node.childNodes && node.childNodes.length > 0 && nodes.length < maxNodes) {
      const children = Array.from(node.childNodes);
      for (let index = 0; index < children.length; index += 1) {
        const childId = serialize(children[index], currentId, path.concat(index), depth + 1);
        if (childId) {
          record.childIds.push(childId);
        }
        if (nodes.length >= maxNodes) {
          truncated = true;
          break;
        }
      }
    }

    return currentId;
  };

  const root = document.documentElement || document.body;
  const rootId = serialize(root, '', [], 0);
  return {
    backend: 'dom',
    title: clip(document.title, 200),
    url: clip(window.location.href, 400),
    truncated,
    rootIds: rootId ? [rootId] : [],
    nodes
  };
}`, maxNodes)
}

func browserDOMClickFunction(pathText string) string {
	return fmt.Sprintf(`() => {
  const pathText = %s;
  const resolve = (raw) => {
    if (!raw || raw === 'root') {
      return document.documentElement || document.body || document;
    }
    let node = document.documentElement || document.body || document;
    for (const part of String(raw).split('.')) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || !node || !node.childNodes || index >= node.childNodes.length) {
        throw new Error('DOM path not found: ' + raw);
      }
      node = node.childNodes[index];
    }
    return node;
  };

  const node = resolve(pathText);
  const element = node instanceof Element ? node : node.parentElement;
  if (!(element instanceof Element)) {
    throw new Error('DOM node is not clickable');
  }
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof element.focus === 'function') {
    element.focus();
  }
  if (typeof element.click === 'function') {
    element.click();
  } else {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  return {
    id: String(pathText || 'root'),
    tag: element.tagName.toLowerCase(),
    clicked: true
  };
}`, browserDOMJSONStringLiteral(pathText))
}

func browserDOMFillFunction(pathText string, valueText string) string {
	return fmt.Sprintf(`() => {
  const pathText = %s;
  const valueText = %s;
  const resolve = (raw) => {
    if (!raw || raw === 'root') {
      return document.documentElement || document.body || document;
    }
    let node = document.documentElement || document.body || document;
    for (const part of String(raw).split('.')) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || !node || !node.childNodes || index >= node.childNodes.length) {
        throw new Error('DOM path not found: ' + raw);
      }
      node = node.childNodes[index];
    }
    return node;
  };

  const node = resolve(pathText);
  const element = node instanceof Element ? node : node.parentElement;
  if (!(element instanceof Element)) {
    throw new Error('DOM node is not fillable');
  }
  const value = String(valueText == null ? '' : valueText);
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof element.focus === 'function') {
    element.focus();
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    element.value = value;
  } else if (element.isContentEditable) {
    element.textContent = value;
  } else {
    throw new Error('DOM node does not support fill');
  }

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    id: String(pathText || 'root'),
    tag: element.tagName.toLowerCase(),
    value
  };
}`, browserDOMJSONStringLiteral(pathText), browserDOMJSONStringLiteral(valueText))
}

func browserDOMJSONStringLiteral(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return `""`
	}
	return string(encoded)
}
