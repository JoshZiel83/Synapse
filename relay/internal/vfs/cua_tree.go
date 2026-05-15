package vfs

import (
	"context"
	"fmt"
	"sort"
	"strconv"

	cuamcp "github.com/PekingSpades/Synapse/relay/internal/builtinmcp/cua"
)

type cuaDisplaysEnvelope struct {
	Displays []cuamcp.DisplayInfo `json:"displays"`
}

type cuaWindowsEnvelope struct {
	Windows []cuamcp.WindowInfo `json:"windows"`
}

type cuaTreeRoot struct {
	Supported   bool     `json:"supported"`
	Backend     string   `json:"backend,omitempty"`
	Message     string   `json:"message,omitempty"`
	NodeCount   int      `json:"nodeCount"`
	FocusedID   string   `json:"focusedId,omitempty"`
	RootIDs     []string `json:"rootIds"`
	AppName     string   `json:"appName,omitempty"`
	WindowTitle string   `json:"windowTitle,omitempty"`
	ProcessID   int      `json:"processId,omitempty"`
}

type cuaDisplayTreeNode struct {
	ID            string      `json:"id"`
	DisplayID     int         `json:"displayId"`
	Index         int         `json:"index"`
	ElectronID    int64       `json:"electronId"`
	IsMain        bool        `json:"isMain"`
	ContainsMouse bool        `json:"containsMouse"`
	Origin        cuamcp.Rect `json:"origin"`
	Size          cuamcp.Size `json:"size"`
	Scale         float64     `json:"scale"`
	WindowIDs     []string    `json:"windowIds,omitempty"`
}

type cuaWindowTreeNode struct {
	ID          string      `json:"id"`
	WindowID    uint64      `json:"windowId"`
	PID         int         `json:"pid"`
	Title       string      `json:"title"`
	Bounds      cuamcp.Rect `json:"bounds"`
	IsVisible   bool        `json:"isVisible"`
	IsMinimized bool        `json:"isMinimized"`
	DisplayIDs  []string    `json:"displayIds,omitempty"`
}

type cuaFocusedProps struct {
	Supported   bool             `json:"supported"`
	Backend     string           `json:"backend,omitempty"`
	Message     string           `json:"message,omitempty"`
	TreeMode    string           `json:"treeMode"`
	TreeRoot    string           `json:"treeRoot"`
	FocusedID   string           `json:"focusedId,omitempty"`
	FocusedNode *cuaSemanticNode `json:"focusedNode,omitempty"`
	AppName     string           `json:"appName,omitempty"`
	WindowTitle string           `json:"windowTitle,omitempty"`
	ProcessID   int              `json:"processId,omitempty"`
}

func (s *Service) cuaDisplays(
	exposure Exposure,
	session *SessionState,
) ([]cuamcp.DisplayInfo, error) {
	result, err := s.callSessionTool(context.Background(), session, exposure.StableKey, "desktop_list_displays", nil)
	if err != nil {
		return nil, err
	}
	envelope, err := decodeStructuredContent[cuaDisplaysEnvelope](result)
	if err != nil {
		return nil, err
	}
	sort.Slice(envelope.Displays, func(i, j int) bool {
		if envelope.Displays[i].Index == envelope.Displays[j].Index {
			return envelope.Displays[i].ID < envelope.Displays[j].ID
		}
		return envelope.Displays[i].Index < envelope.Displays[j].Index
	})
	return envelope.Displays, nil
}

func (s *Service) cuaWindows(
	exposure Exposure,
	session *SessionState,
) ([]cuamcp.WindowInfo, error) {
	result, err := s.callSessionTool(context.Background(), session, exposure.StableKey, "desktop_list_windows", nil)
	if err != nil {
		return nil, err
	}
	envelope, err := decodeStructuredContent[cuaWindowsEnvelope](result)
	if err != nil {
		return nil, err
	}
	sort.Slice(envelope.Windows, func(i, j int) bool {
		if envelope.Windows[i].ID == envelope.Windows[j].ID {
			return envelope.Windows[i].Title < envelope.Windows[j].Title
		}
		return envelope.Windows[i].ID < envelope.Windows[j].ID
	})
	return envelope.Windows, nil
}

func (s *Service) cuaApps(
	exposure Exposure,
	session *SessionState,
	source string,
) (cuamcp.ListAppsResult, error) {
	result, err := s.callSessionTool(context.Background(), session, exposure.StableKey, "desktop_list_apps", map[string]interface{}{
		"source": source,
	})
	if err != nil {
		return cuamcp.ListAppsResult{}, err
	}
	return decodeStructuredContent[cuamcp.ListAppsResult](result)
}

func cuaDisplayNode(display cuamcp.DisplayInfo, windows []cuamcp.WindowInfo) cuaDisplayTreeNode {
	windowIDs := make([]string, 0)
	seen := make(map[string]struct{})
	for _, window := range windows {
		for _, region := range window.Displays {
			if region.DisplayID != display.ID && region.DisplayIndex != display.Index {
				continue
			}
			windowID := cuaWindowPathID(window.ID)
			if _, ok := seen[windowID]; ok {
				continue
			}
			seen[windowID] = struct{}{}
			windowIDs = append(windowIDs, windowID)
		}
	}
	sort.Strings(windowIDs)

	return cuaDisplayTreeNode{
		ID:            cuaDisplayPathID(display.ID),
		DisplayID:     display.ID,
		Index:         display.Index,
		ElectronID:    display.ElectronID,
		IsMain:        display.IsMain,
		ContainsMouse: display.ContainsMouse,
		Origin:        display.Origin,
		Size:          display.Size,
		Scale:         display.Scale,
		WindowIDs:     windowIDs,
	}
}

func cuaWindowNode(window cuamcp.WindowInfo) cuaWindowTreeNode {
	displayIDs := make([]string, 0, len(window.Displays))
	seen := make(map[string]struct{})
	for _, region := range window.Displays {
		displayID := cuaDisplayPathID(region.DisplayID)
		if _, ok := seen[displayID]; ok {
			continue
		}
		seen[displayID] = struct{}{}
		displayIDs = append(displayIDs, displayID)
	}
	sort.Strings(displayIDs)

	return cuaWindowTreeNode{
		ID:          cuaWindowPathID(window.ID),
		WindowID:    window.ID,
		PID:         window.PID,
		Title:       window.Title,
		Bounds:      window.Bounds,
		IsVisible:   window.IsVisible,
		IsMinimized: window.IsMinimized,
		DisplayIDs:  displayIDs,
	}
}

func cuaCurrentDisplayNode(
	displays []cuamcp.DisplayInfo,
	windows []cuamcp.WindowInfo,
) *cuaDisplayTreeNode {
	for _, display := range displays {
		if display.ContainsMouse {
			node := cuaDisplayNode(display, windows)
			return &node
		}
	}
	for _, display := range displays {
		if display.IsMain {
			node := cuaDisplayNode(display, windows)
			return &node
		}
	}
	if len(displays) == 0 {
		return nil
	}
	node := cuaDisplayNode(displays[0], windows)
	return &node
}

func cuaVisibleWindowCount(windows []cuamcp.WindowInfo) int {
	count := 0
	for _, window := range windows {
		if window.IsVisible && !window.IsMinimized {
			count++
		}
	}
	return count
}

func cuaTreeRootSummary(tree *cuaSemanticTree) cuaTreeRoot {
	if tree == nil {
		return cuaTreeRoot{
			Supported: false,
			Message:   "Semantic UIA/AX/AT-SPI tree is not available.",
			RootIDs:   []string{},
		}
	}
	return cuaTreeRoot{
		Supported:   tree.Supported,
		Backend:     tree.Backend,
		Message:     tree.Message,
		NodeCount:   tree.NodeCount,
		FocusedID:   tree.FocusedID,
		RootIDs:     append([]string(nil), tree.RootIDs...),
		AppName:     tree.AppName,
		WindowTitle: tree.WindowTitle,
		ProcessID:   tree.ProcessID,
	}
}

func cuaFocusedSummary(
	basePath string,
	tree *cuaSemanticTree,
) cuaFocusedProps {
	if tree == nil {
		return cuaFocusedProps{
			Supported: false,
			Message:   "Semantic UIA/AX/AT-SPI tree is not available.",
			TreeMode:  "semantic_accessibility_tree",
			TreeRoot:  fmt.Sprintf("%s/tree", basePath),
		}
	}
	focusedNode := cuaSemanticFocusNode(tree)
	return cuaFocusedProps{
		Supported:   tree.Supported,
		Backend:     tree.Backend,
		Message:     tree.Message,
		TreeMode:    "semantic_accessibility_tree",
		TreeRoot:    fmt.Sprintf("%s/tree", basePath),
		FocusedID:   tree.FocusedID,
		FocusedNode: focusedNode,
		AppName:     tree.AppName,
		WindowTitle: tree.WindowTitle,
		ProcessID:   tree.ProcessID,
	}
}

func cuaDisplayPathID(displayID int) string {
	return strconv.Itoa(displayID)
}

func cuaWindowPathID(windowID uint64) string {
	return strconv.FormatUint(windowID, 10)
}

func cuaDisplayBySegment(displays []cuamcp.DisplayInfo, segment string) (*cuamcp.DisplayInfo, error) {
	displayID, err := strconv.Atoi(segment)
	if err != nil {
		return nil, ErrNotFound
	}
	for i := range displays {
		if displays[i].ID == displayID {
			return &displays[i], nil
		}
	}
	return nil, ErrNotFound
}

func cuaWindowBySegment(windows []cuamcp.WindowInfo, segment string) (*cuamcp.WindowInfo, error) {
	windowID, err := strconv.ParseUint(segment, 10, 64)
	if err != nil {
		return nil, ErrNotFound
	}
	for i := range windows {
		if windows[i].ID == windowID {
			return &windows[i], nil
		}
	}
	return nil, ErrNotFound
}
