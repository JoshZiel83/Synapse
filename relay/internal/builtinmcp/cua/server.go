package cua

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
)

type Server struct {
	cfg           Config
	desktop       Desktop
	tools         []core.Tool
	system        string
	startCtx      context.Context
	cancel        context.CancelFunc
	started       bool
	initialized   bool
	startMu       sync.Mutex
	mu            sync.Mutex
	sessionStates map[string]sessionState
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
		cfg:           cfg,
		desktop:       desktop,
		system:        detectSystemDescription(),
		sessionStates: make(map[string]sessionState),
	}
	server.tools = server.buildTools()
	return server
}

func (s *Server) Start(ctx context.Context) error {
	childCtx, cancel := context.WithCancel(ctx)
	s.startCtx = childCtx
	s.cancel = cancel
	if !s.canOperate("") {
		return nil
	}
	return s.ensureReady("")
}

func (s *Server) Initialize() error {
	if !s.canOperate("") {
		return nil
	}
	return s.ensureReady("")
}

func (s *Server) ListTools() ([]core.Tool, error) {
	tools := make([]core.Tool, len(s.tools))
	copy(tools, s.tools)
	return tools, nil
}

func (s *Server) Shutdown() {
	if s.cancel != nil {
		s.cancel()
	}
	if s.desktop != nil {
		_ = s.desktop.Close()
	}
	s.started = false
	s.initialized = false
}

func (s *Server) CloseRuntimeSession(runtimeSessionID string) {
	sessionKey := runtimeSessionStateKey(runtimeSessionID)
	if sessionKey == defaultRuntimeSessionKey {
		return
	}
	s.mu.Lock()
	delete(s.sessionStates, sessionKey)
	s.mu.Unlock()
}

func (s *Server) ResetRuntimeSessions() {
	s.mu.Lock()
	s.sessionStates = make(map[string]sessionState)
	s.mu.Unlock()
}

func (s *Server) CallTool(ctx context.Context, toolName string, args map[string]interface{}) (core.CallResult, error) {
	if s.desktop == nil {
		return errorResult("desktop integration is not available in this build"), nil
	}
	runtimeSessionID := runtimeauth.RuntimeSessionIDFromContext(ctx)
	if !s.canOperate(runtimeSessionID) {
		return disabledResult(toolName), nil
	}
	if err := s.ensureReady(runtimeSessionID); err != nil {
		return errorResult(err.Error()), nil
	}
	if blocked, operation := s.readOnlyBlock(runtimeSessionID, toolName, args); blocked {
		return readOnlyResult(toolName, operation), nil
	}

	switch toolName {
	case "desktop_list_displays":
		return s.listDisplays(), nil
	case "desktop_capture_display":
		return s.captureDisplay(runtimeSessionID, args)
	case "desktop_capture_overview":
		return s.captureOverview(runtimeSessionID, args)
	case "desktop_move_pointer":
		return s.movePointer(runtimeSessionID, args)
	case "desktop_click":
		return s.click(runtimeSessionID, args)
	case "desktop_drag":
		return s.drag(runtimeSessionID, args)
	case "desktop_scroll":
		return s.scroll(runtimeSessionID, args)
	case "desktop_type_text":
		return s.typeText(runtimeSessionID, args)
	case "desktop_press_keys":
		return s.pressKeys(runtimeSessionID, args)
	case "desktop_get_keyboard_state":
		return s.keyboardState(), nil
	case "desktop_list_windows":
		return s.listWindows(), nil
	case "desktop_list_apps":
		return s.listApps(args)
	case "desktop_wait":
		return s.wait(args)
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

func displayChangedResult(displays []DisplayInfo) core.CallResult {
	return core.CallResult{
		Content: []interface{}{core.Text("Detected a display configuration change during this CUA session. Take a fresh screenshot and retry the action.")},
		StructuredContent: map[string]interface{}{
			"code":                      "display_changed",
			"requires_retry":            true,
			"requires_fresh_screenshot": true,
			"displays":                  cloneDisplays(displays),
		},
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

func disabledResult(toolName string) core.CallResult {
	message := "This built-in CUA server is currently disabled. Ask the user to enable desktop access in the Synapse Relay client, then retry."
	return core.CallResult{
		Content: []interface{}{core.Text(message)},
		StructuredContent: map[string]interface{}{
			"code":                   "server_disabled",
			"tool":                   toolName,
			"capability":             "cua",
			"requires_user_approval": true,
			"authorization_duration": "persistent",
			"client_hint":            "Enable desktop access in the Synapse Relay client, then retry the action.",
			"message":                message,
		},
		IsError: true,
	}
}

func (s *Server) readOnlyBlock(runtimeSessionID, toolName string, args map[string]interface{}) (bool, string) {
	if s.cfg.AuthStore != nil && s.cfg.AuthStore.AllowsCUAControl(s.cfg.StableKey, runtimeSessionID) {
		return false, ""
	}
	if !s.cfg.ReadOnly {
		return false, ""
	}

	switch toolName {
	case "desktop_move_pointer", "desktop_click", "desktop_drag", "desktop_scroll", "desktop_type_text", "desktop_press_keys":
		return true, toolName
	}

	return false, ""
}

func (s *Server) canOperate(runtimeSessionID string) bool {
	if s.cfg.Enabled {
		return true
	}
	if s.cfg.AuthStore == nil || s.cfg.StableKey == "" {
		return false
	}
	return s.cfg.AuthStore.AllowsCUAControl(s.cfg.StableKey, runtimeSessionID)
}

func (s *Server) ensureReady(runtimeSessionID string) error {
	s.startMu.Lock()
	defer s.startMu.Unlock()

	if s.desktop == nil {
		return fmt.Errorf("desktop integration is not available in this build")
	}
	if !s.started {
		startCtx := s.startCtx
		if startCtx == nil {
			startCtx = context.Background()
		}
		if err := s.desktop.Start(startCtx); err != nil {
			return err
		}
		s.started = true
	}
	if s.initialized {
		return nil
	}
	if err := s.initializeSessionDisplays(runtimeSessionID); err != nil {
		return err
	}
	s.initialized = true
	return nil
}

func (s *Server) guardStableDisplays(runtimeSessionID string) (core.CallResult, bool) {
	displays, changed, err := s.ensureStableDisplays(runtimeSessionID)
	if err != nil {
		return errorResult(fmt.Sprintf("failed to read displays: %v", err)), true
	}
	if changed {
		return displayChangedResult(displays), true
	}
	return core.CallResult{}, false
}
