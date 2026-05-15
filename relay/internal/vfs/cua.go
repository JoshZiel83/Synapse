package vfs

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strings"
)

func (s *Service) listCUASession(exposure Exposure, session *SessionState, segments []string) ([]Entry, error) {
	basePath := path.Join("/", "cua", exposure.StableKey, "sessions", session.SessionID)
	switch {
	case len(segments) == 0:
		return []Entry{
			fileEntry(path.Join(basePath, "state.json"), "state.json", "application/json", false),
			fileEntry(path.Join(basePath, "close"), "close", "text/plain; charset=utf-8", true),
			dirEntry(path.Join(basePath, "displays"), "displays"),
			dirEntry(path.Join(basePath, "windows"), "windows"),
			dirEntry(path.Join(basePath, "apps"), "apps"),
			dirEntry(path.Join(basePath, "captures"), "captures"),
			dirEntry(path.Join(basePath, "keyboard"), "keyboard"),
			dirEntry(path.Join(basePath, "focused"), "focused"),
			dirEntry(path.Join(basePath, "actions"), "actions"),
			dirEntry(path.Join(basePath, "tree"), "tree"),
		}, nil
	case len(segments) == 1 && segments[0] == "displays":
		return []Entry{fileEntry(path.Join(basePath, "displays", "list.json"), "list.json", "application/json", false)}, nil
	case len(segments) == 1 && segments[0] == "windows":
		return []Entry{fileEntry(path.Join(basePath, "windows", "list.json"), "list.json", "application/json", false)}, nil
	case len(segments) == 1 && segments[0] == "apps":
		return []Entry{fileEntry(path.Join(basePath, "apps", "list.json"), "list.json", "application/json", false)}, nil
	case len(segments) == 1 && segments[0] == "captures":
		return []Entry{dirEntry(path.Join(basePath, "captures", "displays"), "displays")}, nil
	case len(segments) == 1 && segments[0] == "keyboard":
		return []Entry{fileEntry(path.Join(basePath, "keyboard", "state.json"), "state.json", "application/json", false)}, nil
	case len(segments) == 1 && segments[0] == "focused":
		return []Entry{fileEntry(path.Join(basePath, "focused", "props.json"), "props.json", "application/json", false)}, nil
	case len(segments) == 1 && segments[0] == "actions":
		return []Entry{
			fileEntry(path.Join(basePath, "actions", "click"), "click", "application/json", true),
			fileEntry(path.Join(basePath, "actions", "type_text"), "type_text", "application/json", true),
			fileEntry(path.Join(basePath, "actions", "press_keys"), "press_keys", "application/json", true),
			fileEntry(path.Join(basePath, "actions", "scroll"), "scroll", "application/json", true),
		}, nil
	case len(segments) == 1 && segments[0] == "tree":
		return []Entry{
			fileEntry(path.Join(basePath, "tree", "root.json"), "root.json", "application/json", false),
			dirEntry(path.Join(basePath, "tree", "nodes"), "nodes"),
		}, nil
	case len(segments) == 2 && segments[0] == "captures" && segments[1] == "displays":
		return []Entry{fileEntry(path.Join(basePath, "captures", "displays", "main.png"), "main.png", "image/png", false)}, nil
	case len(segments) == 2 && segments[0] == "tree" && segments[1] == "nodes":
		tree := snapshotCUASemanticTree(s)
		entries := []Entry{
			fileEntry(path.Join(basePath, "tree", "nodes", "list.json"), "list.json", "application/json", false),
		}
		for _, node := range tree.Nodes {
			entries = append(entries, dirEntry(path.Join(basePath, "tree", "nodes", node.PathID), node.PathID))
		}
		return entries, nil
	case len(segments) == 3 && segments[0] == "tree" && segments[1] == "nodes":
		tree := snapshotCUASemanticTree(s)
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return nil, err
		}
		entries := []Entry{
			fileEntry(path.Join(basePath, "tree", "nodes", node.PathID, "node.json"), "node.json", "application/json", false),
			fileEntry(path.Join(basePath, "tree", "nodes", node.PathID, "children.json"), "children.json", "application/json", false),
			fileEntry(path.Join(basePath, "tree", "nodes", node.PathID, "text.txt"), "text.txt", "text/plain; charset=utf-8", false),
		}
		if len(node.Actions) > 0 {
			entries = append(entries, dirEntry(path.Join(basePath, "tree", "nodes", node.PathID, "actions"), "actions"))
		}
		return entries, nil
	case len(segments) == 4 && segments[0] == "tree" && segments[1] == "nodes" && segments[3] == "actions":
		tree := snapshotCUASemanticTree(s)
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return nil, err
		}
		entries := make([]Entry, 0, len(node.Actions))
		for _, action := range node.Actions {
			mimeType := "application/json"
			if action == "type_text" {
				mimeType = "text/plain; charset=utf-8"
			}
			entries = append(entries, fileEntry(path.Join(basePath, "tree", "nodes", node.PathID, "actions", action), action, mimeType, true))
		}
		return entries, nil
	default:
		return nil, ErrNotFound
	}
}

func (s *Service) readCUA(exposure Exposure, session *SessionState, segments []string) (ReadResult, error) {
	if len(segments) == 0 {
		return ReadResult{}, ErrIsDirectory
	}
	switch {
	case len(segments) == 1 && segments[0] == "state.json":
		data, err := jsonBytes(session)
		if err != nil {
			return ReadResult{}, err
		}
		return ReadResult{Data: data, MimeType: "application/json"}, nil
	case len(segments) == 1 && segments[0] == "close":
		text := strings.Join([]string{
			"Write any payload to this control file to close the current relay VFS session.",
			"",
			fmt.Sprintf(`Example: echo "close" | synapse-relay vfs write /cua/%s/sessions/%s/close`, exposure.StableKey, session.SessionID),
		}, "\n")
		return ReadResult{Data: []byte(text + "\n"), MimeType: "text/plain; charset=utf-8"}, nil
	case len(segments) == 2 && segments[0] == "displays" && segments[1] == "list.json":
		return s.readCUAEnvelope(exposure, session, "desktop_list_displays", nil)
	case len(segments) == 2 && segments[0] == "windows" && segments[1] == "list.json":
		return s.readCUAEnvelope(exposure, session, "desktop_list_windows", nil)
	case len(segments) == 2 && segments[0] == "apps" && segments[1] == "list.json":
		return s.readCUAEnvelope(exposure, session, "desktop_list_apps", map[string]interface{}{"source": "all"})
	case len(segments) == 3 && segments[0] == "captures" && segments[1] == "displays" && segments[2] == "main.png":
		result, err := s.callSessionTool(context.Background(), session, exposure.StableKey, "desktop_capture_display", nil)
		if err != nil {
			return ReadResult{}, err
		}
		data, mimeType, err := result.FirstImage()
		if err != nil {
			return ReadResult{}, err
		}
		if mimeType == "" {
			mimeType = "image/png"
		}
		return ReadResult{Data: data, MimeType: mimeType}, nil
	case len(segments) == 2 && segments[0] == "keyboard" && segments[1] == "state.json":
		return s.readCUAEnvelope(exposure, session, "desktop_get_keyboard_state", nil)
	case len(segments) == 2 && segments[0] == "focused" && segments[1] == "props.json":
		tree := snapshotCUASemanticTree(s)
		payload := cuaFocusedSummary(path.Join("/", "cua", exposure.StableKey, "sessions", session.SessionID), tree)
		data, err := jsonBytes(payload)
		if err != nil {
			return ReadResult{}, err
		}
		return ReadResult{Data: data, MimeType: "application/json"}, nil
	case len(segments) == 2 && segments[0] == "tree" && segments[1] == "root.json":
		tree := snapshotCUASemanticTree(s)
		data, err := jsonBytes(cuaTreeRootSummary(tree))
		if err != nil {
			return ReadResult{}, err
		}
		return ReadResult{Data: data, MimeType: "application/json"}, nil
	case len(segments) == 3 && segments[0] == "tree" && segments[1] == "nodes" && segments[2] == "list.json":
		tree := snapshotCUASemanticTree(s)
		nodes := append([]cuaSemanticNode(nil), tree.Nodes...)
		data, err := jsonBytes(nodes)
		if err != nil {
			return ReadResult{}, err
		}
		return ReadResult{Data: data, MimeType: "application/json"}, nil
	case len(segments) == 4 && segments[0] == "tree" && segments[1] == "nodes" && segments[3] == "node.json":
		tree := snapshotCUASemanticTree(s)
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return ReadResult{}, err
		}
		data, err := jsonBytes(node)
		if err != nil {
			return ReadResult{}, err
		}
		return ReadResult{Data: data, MimeType: "application/json"}, nil
	case len(segments) == 4 && segments[0] == "tree" && segments[1] == "nodes" && segments[3] == "children.json":
		tree := snapshotCUASemanticTree(s)
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return ReadResult{}, err
		}
		children := make([]cuaSemanticNode, 0, len(node.ChildIDs))
		for _, childID := range node.ChildIDs {
			child, ok := tree.byID[childID]
			if !ok {
				continue
			}
			children = append(children, *child)
		}
		data, err := jsonBytes(children)
		if err != nil {
			return ReadResult{}, err
		}
		return ReadResult{Data: data, MimeType: "application/json"}, nil
	case len(segments) == 4 && segments[0] == "tree" && segments[1] == "nodes" && segments[3] == "text.txt":
		tree := snapshotCUASemanticTree(s)
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return ReadResult{}, err
		}
		text := strings.TrimSpace(node.Text)
		if text == "" {
			text = strings.TrimSpace(node.Value)
		}
		if text == "" {
			text = strings.TrimSpace(node.Summary)
		}
		return ReadResult{Data: []byte(text + "\n"), MimeType: "text/plain; charset=utf-8"}, nil
	default:
		return ReadResult{}, ErrNotFound
	}
}

func (s *Service) readCUAEnvelope(
	exposure Exposure,
	session *SessionState,
	toolName string,
	args map[string]interface{},
) (ReadResult, error) {
	result, err := s.callSessionTool(context.Background(), session, exposure.StableKey, toolName, args)
	if err != nil {
		return ReadResult{}, err
	}
	envelope, err := resultEnvelope(result)
	if err != nil {
		return ReadResult{}, err
	}
	data, err := jsonBytes(envelope)
	if err != nil {
		return ReadResult{}, err
	}
	return ReadResult{Data: data, MimeType: "application/json"}, nil
}

func (s *Service) writeCUA(exposure Exposure, session *SessionState, segments []string, data []byte) (WriteResult, error) {
	if len(segments) == 5 && segments[0] == "tree" && segments[1] == "nodes" && segments[3] == "actions" {
		tree := snapshotCUASemanticTree(s)
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return WriteResult{}, err
		}
		if !cuaSemanticNodeHasAction(node, segments[4]) {
			return WriteResult{}, ErrNotFound
		}
		return s.writeCUASemanticAction(exposure, session, node, segments[4], data)
	}
	if len(segments) != 2 || segments[0] != "actions" {
		return WriteResult{}, ErrNotFound
	}

	action := segments[1]
	payload, err := parseCUAActionPayload(action, data)
	if err != nil {
		return WriteResult{}, err
	}

	toolName := ""
	switch action {
	case "click":
		toolName = "desktop_click"
	case "type_text":
		toolName = "desktop_type_text"
	case "press_keys":
		toolName = "desktop_press_keys"
	case "scroll":
		toolName = "desktop_scroll"
	default:
		return WriteResult{}, ErrNotFound
	}

	result, err := s.callSessionTool(context.Background(), session, exposure.StableKey, toolName, payload)
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
	_ = session
	return WriteResult{Data: response, MimeType: "application/json"}, nil
}

func parseCUAActionPayload(action string, data []byte) (map[string]interface{}, error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return map[string]interface{}{}, nil
	}
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") || trimmed == "null" {
		var payload map[string]interface{}
		if err := json.Unmarshal(data, &payload); err != nil {
			return nil, fmt.Errorf("cua action payload must be valid JSON: %w", err)
		}
		if payload == nil {
			payload = map[string]interface{}{}
		}
		return payload, nil
	}
	if action == "type_text" {
		return map[string]interface{}{"text": trimmed}, nil
	}
	if action == "press_keys" {
		return parseCUAPressKeysPayload(trimmed), nil
	}
	return nil, fmt.Errorf("cua action payload must be valid JSON")
}

var cuaPressKeysSplitPattern = regexp.MustCompile(`[+,]`)

func parseCUAPressKeysPayload(trimmed string) map[string]interface{} {
	lines := strings.Split(trimmed, "\n")
	sequence := make([][]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := cuaPressKeysSplitPattern.Split(line, -1)
		chord := make([]string, 0, len(parts))
		for _, part := range parts {
			key := strings.TrimSpace(strings.ToLower(part))
			if key == "" {
				continue
			}
			chord = append(chord, key)
		}
		if len(chord) > 0 {
			sequence = append(sequence, chord)
		}
	}
	if len(sequence) == 1 {
		return map[string]interface{}{"keys": sequence[0]}
	}
	return map[string]interface{}{"sequence": sequence}
}
