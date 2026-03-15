package cua

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

type Server struct {
	cfg     Config
	desktop Desktop
	tools   []core.Tool
}

func New(cfg Config) (*Server, error) {
	desktop, err := newDefaultDesktop()
	if err != nil {
		return nil, err
	}
	return NewWithDesktop(cfg, desktop), nil
}

func NewWithDesktop(cfg Config, desktop Desktop) *Server {
	cfg = applyDefaults(cfg)
	server := &Server{
		cfg:     cfg,
		desktop: desktop,
	}
	server.tools = server.buildTools()
	return server
}

func (s *Server) Start(ctx context.Context) error {
	if s.desktop == nil {
		return fmt.Errorf("desktop integration is not available in this build")
	}
	return s.desktop.Start(ctx)
}

func (s *Server) Initialize() error {
	if s.desktop == nil {
		return fmt.Errorf("desktop integration is not available in this build")
	}
	_, err := s.desktop.ListDisplays()
	return err
}

func (s *Server) ListTools() ([]core.Tool, error) {
	tools := make([]core.Tool, len(s.tools))
	copy(tools, s.tools)
	return tools, nil
}

func (s *Server) Shutdown() {
	if s.desktop != nil {
		_ = s.desktop.Close()
	}
}

func (s *Server) CallTool(ctx context.Context, toolName string, args map[string]interface{}) (core.CallResult, error) {
	if s.desktop == nil {
		return errorResult("desktop integration is not available in this build"), nil
	}
	if blocked, operation := s.readOnlyBlock(toolName, args); blocked {
		return readOnlyResult(toolName, operation), nil
	}

	switch toolName {
	case "desktop_list_displays":
		return s.listDisplays(), nil
	case "desktop_capture_display":
		return s.captureDisplay(args)
	case "desktop_capture_overview":
		return s.captureOverview(args)
	case "desktop_get_pointer":
		return s.getPointer(), nil
	case "desktop_move_pointer":
		return s.movePointer(args)
	case "desktop_click":
		return s.click(args)
	case "desktop_drag":
		return s.drag(args)
	case "desktop_scroll":
		return s.scroll(args)
	case "desktop_type_text":
		return s.typeText(args)
	case "desktop_press_keys":
		return s.pressKeys(args)
	case "desktop_get_keyboard_state":
		return s.keyboardState(), nil
	case "desktop_list_windows":
		return s.listWindows(), nil
	case "desktop_wait":
		return s.wait(args)
	case "computer":
		return s.computer(args)
	default:
		return errorResult(fmt.Sprintf("unknown tool: %s", toolName)), nil
	}
}

func applyDefaults(cfg Config) Config {
	if cfg.ImageSize == [2]int{} {
		cfg.ImageSize = [2]int{1280, 800}
	}
	if cfg.RelativeSize == [2]int{} {
		cfg.RelativeSize = [2]int{1000, 1000}
	}
	if cfg.ScrollMultiplier <= 0 {
		cfg.ScrollMultiplier = 1
	}
	if cfg.DisplaySelector.Mode == "" {
		cfg.DisplaySelector.Mode = "main"
	}
	return cfg
}

func decodeArgs(input map[string]interface{}, target interface{}) error {
	if len(input) == 0 {
		return nil
	}
	data, err := json.Marshal(input)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func textResult(text string, structured interface{}) core.CallResult {
	content := []interface{}{core.Text(text)}
	return core.CallResult{
		Content:           content,
		StructuredContent: structured,
		IsError:           false,
	}
}

func textAndImageResult(text string, imageData string, structured interface{}) core.CallResult {
	return core.CallResult{
		Content: []interface{}{
			core.Text(text),
			core.PNGImage(imageData),
		},
		StructuredContent: structured,
	}
}

func errorResult(text string) core.CallResult {
	return core.CallResult{
		Content: []interface{}{core.Text(text)},
		IsError: true,
	}
}

func readOnlyResult(toolName, operation string) core.CallResult {
	message := "This built-in CUA server is currently in read-only mode. Observation tools remain available, but this action requires manual approval in the Synapse Relay client. Ask the user to disable read-only mode there, then retry."
	if operation != "" {
		message = fmt.Sprintf("The requested action %q is blocked because this built-in CUA server is currently in read-only mode. Observation tools remain available, but input actions require manual approval in the Synapse Relay client. Ask the user to disable read-only mode there, then retry.", operation)
	}
	return core.CallResult{
		Content: []interface{}{core.Text(message)},
		StructuredContent: map[string]interface{}{
			"code":                   "read_only_mode",
			"read_only":              true,
			"tool":                   toolName,
			"operation":              operation,
			"requires_user_approval": true,
			"client_hint":            "Disable read-only mode in the Synapse Relay client, then retry the action.",
		},
		IsError: true,
	}
}

func (s *Server) readOnlyBlock(toolName string, args map[string]interface{}) (bool, string) {
	if !s.cfg.ReadOnly {
		return false, ""
	}

	switch toolName {
	case "desktop_move_pointer", "desktop_click", "desktop_drag", "desktop_scroll", "desktop_type_text", "desktop_press_keys":
		return true, toolName
	case "computer":
		action, _ := args["action"].(string)
		switch action {
		case "left_click", "right_click", "middle_click", "double_click", "triple_click", "mouse_move", "type", "scroll", "key", "left_click_drag":
			return true, action
		}
	}

	return false, ""
}
