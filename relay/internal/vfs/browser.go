package vfs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
)

func (s *Service) listBrowserSession(exposure Exposure, session *SessionState, segments []string) ([]Entry, error) {
	basePath := path.Join("/", "browser", exposure.StableKey, "sessions", session.SessionID)
	switch {
	case len(segments) == 0:
		return []Entry{
			fileEntry(path.Join(basePath, "state.json"), "state.json", "application/json", false),
			fileEntry(path.Join(basePath, "close"), "close", "text/plain; charset=utf-8", true),
			dirEntry(path.Join(basePath, "pages"), "pages"),
			dirEntry(path.Join(basePath, "current"), "current"),
			dirEntry(path.Join(basePath, "actions"), "actions"),
			dirEntry(path.Join(basePath, "tree"), "tree"),
		}, nil
	case len(segments) == 1 && segments[0] == "pages":
		return []Entry{
			fileEntry(path.Join(basePath, "pages", "list.json"), "list.json", "application/json", false),
		}, nil
	case len(segments) == 1 && segments[0] == "current":
		return []Entry{
			fileEntry(path.Join(basePath, "current", "page.json"), "page.json", "application/json", false),
			fileEntry(path.Join(basePath, "current", "snapshot.txt"), "snapshot.txt", "text/plain; charset=utf-8", false),
			fileEntry(path.Join(basePath, "current", "screenshot.png"), "screenshot.png", "image/png", false),
		}, nil
	case len(segments) == 1 && segments[0] == "actions":
		return []Entry{
			fileEntry(path.Join(basePath, "actions", "navigate"), "navigate", "application/json", true),
			fileEntry(path.Join(basePath, "actions", "new_page"), "new_page", "application/json", true),
			fileEntry(path.Join(basePath, "actions", "select_page"), "select_page", "application/json", true),
			fileEntry(path.Join(basePath, "actions", "click"), "click", "application/json", true),
			fileEntry(path.Join(basePath, "actions", "fill"), "fill", "application/json", true),
			fileEntry(path.Join(basePath, "actions", "press_key"), "press_key", "application/json", true),
			fileEntry(path.Join(basePath, "actions", "evaluate"), "evaluate", "application/json", true),
		}, nil
	case len(segments) == 1 && segments[0] == "tree":
		return []Entry{
			fileEntry(path.Join(basePath, "tree", "index.json"), "index.json", "application/json", false),
			fileEntry(path.Join(basePath, "tree", "snapshot.txt"), "snapshot.txt", "text/plain; charset=utf-8", false),
			dirEntry(path.Join(basePath, "tree", "nodes"), "nodes"),
		}, nil
	case len(segments) == 2 && segments[0] == "tree" && segments[1] == "nodes":
		tree, err := s.browserTree(exposure, session)
		if err != nil {
			return nil, err
		}
		entries := []Entry{
			fileEntry(path.Join(basePath, "tree", "nodes", "list.json"), "list.json", "application/json", false),
		}
		for _, node := range tree.Nodes {
			entries = append(entries, dirEntry(path.Join(basePath, "tree", "nodes", node.PathID), node.PathID))
		}
		return entries, nil
	case len(segments) == 3 && segments[0] == "tree" && segments[1] == "nodes":
		tree, err := s.browserTree(exposure, session)
		if err != nil {
			return nil, err
		}
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return nil, err
		}
		entries := []Entry{
			fileEntry(path.Join(basePath, "tree", "nodes", node.PathID, "node.json"), "node.json", "application/json", false),
			fileEntry(path.Join(basePath, "tree", "nodes", node.PathID, "text.txt"), "text.txt", "text/plain; charset=utf-8", false),
			fileEntry(path.Join(basePath, "tree", "nodes", node.PathID, "children.json"), "children.json", "application/json", false),
		}
		if node.UID != "" {
			entries = append(entries, fileEntry(path.Join(basePath, "tree", "nodes", node.PathID, "screenshot.png"), "screenshot.png", "image/png", false))
		}
		if len(node.Actions) > 0 {
			entries = append(entries, dirEntry(path.Join(basePath, "tree", "nodes", node.PathID, "actions"), "actions"))
		}
		return entries, nil
	case len(segments) == 4 && segments[0] == "tree" && segments[1] == "nodes" && segments[3] == "actions":
		tree, err := s.browserTree(exposure, session)
		if err != nil {
			return nil, err
		}
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return nil, err
		}
		if len(node.Actions) == 0 {
			return nil, ErrNotFound
		}
		entries := make([]Entry, 0, len(node.Actions))
		for _, action := range node.Actions {
			mimeType := "application/json"
			if action == "fill" {
				mimeType = "text/plain; charset=utf-8"
			}
			entries = append(entries, fileEntry(path.Join(basePath, "tree", "nodes", node.PathID, "actions", action), action, mimeType, true))
		}
		return entries, nil
	default:
		return nil, ErrNotFound
	}
}

func (s *Service) readBrowser(exposure Exposure, session *SessionState, segments []string) (ReadResult, error) {
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
			fmt.Sprintf(`Example: echo "close" | synapse-relay vfs write /browser/%s/sessions/%s/close`, exposure.StableKey, session.SessionID),
		}, "\n")
		return ReadResult{Data: []byte(text + "\n"), MimeType: "text/plain; charset=utf-8"}, nil
	case len(segments) == 2 && segments[0] == "pages" && segments[1] == "list.json":
		result, err := s.callBrowserTool(context.Background(), exposure.StableKey, session, "list_pages", nil)
		if err != nil {
			return ReadResult{}, err
		}
		envelope, err := resultEnvelope(result)
		if err != nil {
			return ReadResult{}, err
		}
		envelope["selectedPageId"] = session.SelectedPageID
		data, err := jsonBytes(envelope)
		if err != nil {
			return ReadResult{}, err
		}
		return ReadResult{Data: data, MimeType: "application/json"}, nil
	case len(segments) == 2 && segments[0] == "current" && segments[1] == "page.json":
		result, err := s.callBrowserTool(context.Background(), exposure.StableKey, session, "list_pages", nil)
		if err != nil {
			return ReadResult{}, err
		}
		envelope, err := resultEnvelope(result)
		if err != nil {
			return ReadResult{}, err
		}
		page := map[string]interface{}{
			"selectedPageId": session.SelectedPageID,
			"pages":          envelope,
		}
		data, err := jsonBytes(page)
		if err != nil {
			return ReadResult{}, err
		}
		return ReadResult{Data: data, MimeType: "application/json"}, nil
	case len(segments) == 2 && segments[0] == "current" && segments[1] == "snapshot.txt":
		result, err := s.callBrowserTool(context.Background(), exposure.StableKey, session, "take_snapshot", nil)
		if err != nil {
			return ReadResult{}, err
		}
		text := result.Text()
		if text == "" {
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
		return ReadResult{Data: []byte(text + "\n"), MimeType: "text/plain; charset=utf-8"}, nil
	case len(segments) == 2 && segments[0] == "current" && segments[1] == "screenshot.png":
		tempFile, err := writeTempFile(s.paths.HostPaths.TempRoot, "relay-browser-screenshot-*.png")
		if err != nil {
			return ReadResult{}, err
		}
		tempPath := tempFile.Name()
		_ = tempFile.Close()
		defer os.Remove(tempPath)

		result, err := s.callBrowserTool(context.Background(), exposure.StableKey, session, "take_screenshot", map[string]interface{}{
			"filePath": tempPath,
			"format":   "png",
		})
		if err == nil {
			if data, readErr := os.ReadFile(tempPath); readErr == nil && len(data) > 0 {
				return ReadResult{Data: data, MimeType: "image/png"}, nil
			}
			if data, mimeType, imageErr := result.FirstImage(); imageErr == nil {
				if mimeType == "" {
					mimeType = "image/png"
				}
				return ReadResult{Data: data, MimeType: mimeType}, nil
			}
		}
		return ReadResult{}, err
	case len(segments) == 2 && segments[0] == "tree" && segments[1] == "snapshot.txt":
		tree, err := s.browserTree(exposure, session)
		if err != nil {
			return ReadResult{}, err
		}
		snapshot := renderBrowserTree(tree)
		if strings.TrimSpace(snapshot) == "" {
			return ReadResult{Data: []byte{}, MimeType: "text/plain; charset=utf-8"}, nil
		}
		return ReadResult{Data: []byte(snapshot + "\n"), MimeType: "text/plain; charset=utf-8"}, nil
	case len(segments) == 2 && segments[0] == "tree" && segments[1] == "index.json":
		tree, err := s.browserTree(exposure, session)
		if err != nil {
			return ReadResult{}, err
		}
		data, err := jsonBytes(tree)
		if err != nil {
			return ReadResult{}, err
		}
		return ReadResult{Data: data, MimeType: "application/json"}, nil
	case len(segments) == 3 && segments[0] == "tree" && segments[1] == "nodes" && segments[2] == "list.json":
		tree, err := s.browserTree(exposure, session)
		if err != nil {
			return ReadResult{}, err
		}
		data, err := jsonBytes(tree.Nodes)
		if err != nil {
			return ReadResult{}, err
		}
		return ReadResult{Data: data, MimeType: "application/json"}, nil
	case len(segments) == 4 && segments[0] == "tree" && segments[1] == "nodes" && segments[3] == "node.json":
		tree, err := s.browserTree(exposure, session)
		if err != nil {
			return ReadResult{}, err
		}
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return ReadResult{}, err
		}
		data, err := jsonBytes(node)
		if err != nil {
			return ReadResult{}, err
		}
		return ReadResult{Data: data, MimeType: "application/json"}, nil
	case len(segments) == 4 && segments[0] == "tree" && segments[1] == "nodes" && segments[3] == "text.txt":
		tree, err := s.browserTree(exposure, session)
		if err != nil {
			return ReadResult{}, err
		}
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return ReadResult{}, err
		}
		text := strings.TrimSpace(node.Text)
		if text == "" {
			text = node.Line
		}
		return ReadResult{Data: []byte(text + "\n"), MimeType: "text/plain; charset=utf-8"}, nil
	case len(segments) == 4 && segments[0] == "tree" && segments[1] == "nodes" && segments[3] == "children.json":
		tree, err := s.browserTree(exposure, session)
		if err != nil {
			return ReadResult{}, err
		}
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return ReadResult{}, err
		}
		children := make([]browserTreeNode, 0, len(node.ChildIDs))
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
	case len(segments) == 4 && segments[0] == "tree" && segments[1] == "nodes" && segments[3] == "screenshot.png":
		tree, err := s.browserTree(exposure, session)
		if err != nil {
			return ReadResult{}, err
		}
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return ReadResult{}, err
		}
		if node.UID == "" {
			return ReadResult{}, ErrNotFound
		}
		tempFile, err := writeTempFile(s.paths.HostPaths.TempRoot, "relay-browser-node-*.png")
		if err != nil {
			return ReadResult{}, err
		}
		tempPath := tempFile.Name()
		_ = tempFile.Close()
		defer os.Remove(tempPath)

		result, err := s.callBrowserTool(context.Background(), exposure.StableKey, session, "take_screenshot", map[string]interface{}{
			"uid":      node.UID,
			"filePath": tempPath,
			"format":   "png",
		})
		if err == nil {
			if data, readErr := os.ReadFile(tempPath); readErr == nil && len(data) > 0 {
				return ReadResult{Data: data, MimeType: "image/png"}, nil
			}
			if data, mimeType, imageErr := result.FirstImage(); imageErr == nil {
				if mimeType == "" {
					mimeType = "image/png"
				}
				return ReadResult{Data: data, MimeType: mimeType}, nil
			}
		}
		return ReadResult{}, err
	default:
		return ReadResult{}, ErrNotFound
	}
}

func (s *Service) writeBrowser(exposure Exposure, session *SessionState, segments []string, data []byte) (WriteResult, error) {
	if len(segments) == 5 && segments[0] == "tree" && segments[1] == "nodes" && segments[3] == "actions" {
		tree, err := s.browserTree(exposure, session)
		if err != nil {
			return WriteResult{}, err
		}
		node, err := tree.nodeBySegment(segments[2])
		if err != nil {
			return WriteResult{}, err
		}
		if !browserNodeHasAction(node, segments[4]) {
			return WriteResult{}, ErrNotFound
		}
		if node.UID == "" {
			switch segments[4] {
			case "click":
				return s.browserDOMNodeClick(exposure, session, node)
			case "fill":
				return s.browserDOMNodeFill(exposure, session, node, data)
			default:
				return WriteResult{}, ErrNotFound
			}
		}

		payload, err := parseBrowserNodeActionPayload(segments[4], node.UID, data)
		if err != nil {
			return WriteResult{}, err
		}
		result, err := s.callBrowserTool(context.Background(), exposure.StableKey, session, segments[4], payload)
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

	if len(segments) != 2 || segments[0] != "actions" {
		return WriteResult{}, ErrNotFound
	}

	action := segments[1]
	payload, err := parseBrowserActionPayload(action, data)
	if err != nil {
		return WriteResult{}, err
	}

	toolName := ""
	switch action {
	case "navigate":
		toolName = "navigate_page"
	case "new_page":
		toolName = "new_page"
	case "select_page":
		toolName = "select_page"
	case "click":
		toolName = "click"
	case "fill":
		toolName = "fill"
	case "press_key":
		toolName = "press_key"
	case "evaluate":
		toolName = "evaluate"
	default:
		return WriteResult{}, ErrNotFound
	}

	result, err := s.callBrowserTool(context.Background(), exposure.StableKey, session, toolName, payload)
	if err != nil {
		return WriteResult{}, err
	}
	if toolName == "select_page" {
		if pageID, ok := browserPayloadPageID(payload["pageId"]); ok {
			s.mu.Lock()
			session.SelectedPageID = pageID
			s.mu.Unlock()
		}
	} else if toolName == "new_page" && !browserPayloadBool(payload["background"]) {
		s.syncBrowserSelectedPage(exposure.StableKey, session, result)
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

func (s *Service) callBrowserTool(
	ctx context.Context,
	exposureStableKey string,
	session *SessionState,
	toolName string,
	args map[string]interface{},
) (*toolResult, error) {
	if args == nil {
		args = map[string]interface{}{}
	}
	switch toolName {
	case "list_pages", "select_page", "new_page":
	default:
		if session.SelectedPageID != 0 {
			_, err := s.callSessionTool(ctx, session, exposureStableKey, "select_page", map[string]interface{}{
				"pageId": session.SelectedPageID,
			})
			if err != nil {
				return nil, err
			}
		}
	}
	return s.callSessionTool(ctx, session, exposureStableKey, toolName, args)
}

func parseBrowserActionPayload(action string, data []byte) (map[string]interface{}, error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return map[string]interface{}{}, nil
	}
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") || trimmed == "null" {
		var payload map[string]interface{}
		if err := json.Unmarshal(data, &payload); err != nil {
			return nil, fmt.Errorf("browser action payload must be valid JSON: %w", err)
		}
		if payload == nil {
			payload = map[string]interface{}{}
		}
		return payload, nil
	}

	switch action {
	case "navigate":
		return map[string]interface{}{"url": trimmed}, nil
	case "new_page":
		return map[string]interface{}{"url": trimmed}, nil
	case "select_page":
		pageID, err := strconv.Atoi(trimmed)
		if err != nil {
			return nil, fmt.Errorf("browser select_page payload must be JSON or an integer page id: %w", err)
		}
		return map[string]interface{}{"pageId": pageID}, nil
	case "press_key":
		return map[string]interface{}{"key": trimmed}, nil
	default:
		return nil, fmt.Errorf("browser action payload must be valid JSON")
	}
}

func parseBrowserNodeActionPayload(action string, uid string, data []byte) (map[string]interface{}, error) {
	trimmed := strings.TrimSpace(string(data))
	if action == "fill" && trimmed != "" && !strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "[") && trimmed != "null" {
		return map[string]interface{}{
			"uid":   uid,
			"value": trimmed,
		}, nil
	}

	payload, err := parseBrowserActionPayload(action, data)
	if err != nil {
		return nil, err
	}
	payload["uid"] = uid
	return payload, nil
}

func browserPayloadPageID(value interface{}) (int, bool) {
	switch typed := value.(type) {
	case float64:
		return int(typed), true
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		return int(parsed), true
	default:
		return 0, false
	}
}

func browserPayloadBool(value interface{}) bool {
	typed, ok := value.(bool)
	return ok && typed
}

var browserPageIDPattern = regexp.MustCompile(`(?i)\bpage[_ ]?id\b[^0-9]*([0-9]+)`)
var browserSelectedPageLinePattern = regexp.MustCompile(`(?im)^\s*([0-9]+):.*\[(selected|active)\]`)

func (s *Service) syncBrowserSelectedPage(exposureStableKey string, session *SessionState, newPageResult *toolResult) {
	if pageID, ok := browserExtractSelectedPageID(newPageResult); ok {
		s.mu.Lock()
		session.SelectedPageID = pageID
		s.mu.Unlock()
		return
	}

	result, err := s.callSessionTool(context.Background(), session, exposureStableKey, "list_pages", nil)
	if err != nil {
		return
	}
	if pageID, ok := browserExtractSelectedPageID(result); ok {
		s.mu.Lock()
		session.SelectedPageID = pageID
		s.mu.Unlock()
	}
}

func browserExtractSelectedPageID(result *toolResult) (int, bool) {
	if result == nil {
		return 0, false
	}

	if hasStructuredContent(result.StructuredContent) {
		var value interface{}
		if err := json.Unmarshal(result.StructuredContent, &value); err == nil {
			if pageID, ok := browserFindSelectedPageID(value); ok {
				return pageID, true
			}
		}
	}

	if text := result.Text(); text != "" {
		if matches := browserSelectedPageLinePattern.FindAllStringSubmatch(text, -1); len(matches) > 0 {
			candidate := 0
			for _, match := range matches {
				if len(match) < 2 {
					continue
				}
				pageID, err := strconv.Atoi(match[1])
				if err != nil {
					continue
				}
				if pageID > candidate {
					candidate = pageID
				}
			}
			if candidate > 0 {
				return candidate, true
			}
		}
		matches := browserPageIDPattern.FindAllStringSubmatch(text, -1)
		candidate := 0
		for _, match := range matches {
			if len(match) < 2 {
				continue
			}
			pageID, err := strconv.Atoi(match[1])
			if err != nil {
				continue
			}
			if pageID > candidate {
				candidate = pageID
			}
		}
		if candidate > 0 {
			return candidate, true
		}
	}
	return 0, false
}

func browserFindSelectedPageID(value interface{}) (int, bool) {
	selectedKeys := map[string]struct{}{
		"selectedPageId":   {},
		"selected_page_id": {},
	}
	pageIDKeys := map[string]struct{}{
		"pageId":   {},
		"pageID":   {},
		"page_id":  {},
		"id":       {},
		"pageIdx":  {},
		"page_idx": {},
	}

	var selectedCandidate int
	var pageCandidate int
	var walk func(interface{}, string)
	walk = func(current interface{}, parentKey string) {
		switch typed := current.(type) {
		case map[string]interface{}:
			for key, value := range typed {
				if _, ok := selectedKeys[key]; ok {
					if pageID, ok := browserPayloadPageID(value); ok && pageID > selectedCandidate {
						selectedCandidate = pageID
					}
				}
				if _, ok := pageIDKeys[key]; ok {
					if pageID, ok := browserPayloadPageID(value); ok && pageID > pageCandidate {
						pageCandidate = pageID
					}
				}
				walk(value, key)
			}
		case []interface{}:
			for _, item := range typed {
				walk(item, parentKey)
			}
		}
	}

	walk(value, "")
	if selectedCandidate > 0 {
		return selectedCandidate, true
	}
	if pageCandidate > 0 {
		return pageCandidate, true
	}
	return 0, false
}
