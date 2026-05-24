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
	guard         *sessionGuard
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
		guard:         newSessionGuard(cfg.StateDir),
		sessionStates: make(map[string]sessionState),
	}
	if aware, ok := desktop.(captureOptionsAwareDesktop); ok && server.guard != nil {
		aware.SetCaptureOptionsProvider(server.guard.CaptureOptions)
	}
	server.tools = server.buildTools()
	return server
}

func (s *Server) Start(ctx context.Context) error {
	childCtx, cancel := context.WithCancel(ctx)
	s.startCtx = childCtx
	s.cancel = cancel
	if err := s.guard.Start(); err != nil {
		return err
	}
	if !s.canOperate(false, "") {
		return nil
	}
	return s.ensureReady("")
}

func (s *Server) Initialize() error {
	if err := s.guard.Start(); err != nil {
		return err
	}
	if !s.canOperate(false, "") {
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
	if s.guard != nil {
		_ = s.guard.Close()
	}
	if s.desktop != nil {
		_ = s.desktop.Close()
	}
	s.started = false
	s.initialized = false
}

func (s *Server) SetEventEmitter(handler func(string, string, map[string]interface{})) {
	if s.guard == nil {
		return
	}
	s.guard.SetEventEmitter(handler)
}

func (s *Server) SetCUASessionTerminator(handler func(string, string)) {
	if s.guard == nil {
		return
	}
	s.guard.SetTerminator(handler)
}

func (s *Server) OpenRuntimeSession(runtimeSessionID string) error {
	if s.guard == nil {
		return nil
	}
	return s.guard.OpenRuntimeSession(runtimeSessionID)
}

func (s *Server) CloseRuntimeSession(runtimeSessionID string) {
	sessionKey := runtimeSessionStateKey(runtimeSessionID)
	if sessionKey == defaultRuntimeSessionKey {
		return
	}
	if s.guard != nil {
		s.guard.CloseRuntimeSession(runtimeSessionID)
	}
	s.mu.Lock()
	delete(s.sessionStates, sessionKey)
	s.mu.Unlock()
}

func (s *Server) ResetRuntimeSessions() {
	if s.guard != nil {
		s.guard.Reset()
	}
	s.mu.Lock()
	s.sessionStates = make(map[string]sessionState)
	s.mu.Unlock()
}

func (s *Server) CallTool(ctx context.Context, toolName string, args map[string]interface{}) (core.CallResult, error) {
	if s.desktop == nil {
		return errorResult("desktop integration is not available in this build"), nil
	}
	runtimeSessionID := runtimeauth.RuntimeSessionIDFromContext(ctx)
	access := cuaAccessForTool(toolName)
	serverAuthorized := s.hasMatchingServerAuthorization(ctx, access)
	if !s.canOperate(serverAuthorized, runtimeSessionID) {
		return disabledResult(toolName, s.denialResolution()), nil
	}
	if err := s.ensureReady(runtimeSessionID); err != nil {
		return errorResult(err.Error()), nil
	}
	if blocked, operation := s.readOnlyBlock(serverAuthorized, runtimeSessionID, toolName, args); blocked {
		return readOnlyResult(toolName, operation, s.denialResolution()), nil
	}
	if s.guard != nil {
		if guardResult := s.guard.BeforeToolCall(runtimeSessionID); guardResult != nil {
			return *guardResult, nil
		}
	}

	switch toolName {
	case "desktop_list_displays":
		return s.listDisplays(runtimeSessionID), nil
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
		return s.listWindows(runtimeSessionID), nil
	case "desktop_list_apps":
		return s.listApps(runtimeSessionID, args)
	case "desktop_wait":
		return s.wait(runtimeSessionID, args)
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
		StructuredContent: core.WithRelayAccessDenial(map[string]interface{}{
			"code":                      "display_changed",
			"requires_retry":            true,
			"requires_fresh_screenshot": true,
			"displays":                  cloneDisplays(displays),
		}, core.RelayAccessDenialKindRuntimeConstraint, core.RelayAccessDenialResolutionUnresolvable),
		IsError: true,
	}
}

func readOnlyResult(toolName, operation string, resolution string) core.CallResult {
	message := "This built-in CUA server is currently in read-only mode. Observation tools remain available, but input actions require relay authorization before retrying."
	if operation != "" {
		message = fmt.Sprintf("The requested action %q is blocked because this built-in CUA server is currently in read-only mode. Observation tools remain available, but input actions require relay authorization before retrying.", operation)
	}
	if resolution == core.RelayAccessDenialResolutionLocalSetting {
		message = "This built-in CUA server is currently in read-only mode. Observation tools remain available, and this relay client is not configured to trust server-issued relay authorizations for input actions."
		if operation != "" {
			message = fmt.Sprintf("The requested action %q is blocked because this built-in CUA server is currently in read-only mode, and this relay client is not configured to trust server-issued relay authorizations for input actions.", operation)
		}
	}
	return core.CallResult{
		Content: []interface{}{core.Text(message)},
		StructuredContent: core.WithRelayAccessDenial(map[string]interface{}{
			"code":      "read_only_mode",
			"read_only": true,
			"tool":      toolName,
			"operation": operation,
			"message":   message,
		}, core.RelayAccessDenialKindPermissionDenied, resolution),
		IsError: true,
	}
}

func disabledResult(toolName string, resolution string) core.CallResult {
	message := "This built-in CUA server is currently blocked by the relay client's local policy."
	if resolution == core.RelayAccessDenialResolutionServerGrant {
		message += " Synapse can continue after the matching relay authorization is approved."
	} else {
		message += " This relay client is not configured to trust server-issued relay authorizations."
	}
	return core.CallResult{
		Content: []interface{}{core.Text(message)},
		StructuredContent: core.WithRelayAccessDenial(map[string]interface{}{
			"code":       "server_disabled",
			"tool":       toolName,
			"capability": "cua",
			"message":    message,
		}, core.RelayAccessDenialKindPermissionDenied, resolution),
		IsError: true,
	}
}

func cuaAccessForTool(toolName string) string {
	switch toolName {
	case "desktop_move_pointer", "desktop_click", "desktop_drag", "desktop_scroll", "desktop_type_text", "desktop_press_keys":
		return "write"
	default:
		return "read"
	}
}

func (s *Server) denialResolution() string {
	return core.RelayAccessDenialResolutionServerGrant
}

func (s *Server) hasMatchingServerAuthorization(ctx context.Context, access string) bool {
	return runtimeauth.IsAuthorized(ctx, runtimeauth.AccessRequest{
		Capability: "cua",
		CUA:        &runtimeauth.CUARequest{Access: access},
	})
}

func (s *Server) readOnlyBlock(serverAuthorized bool, runtimeSessionID, toolName string, args map[string]interface{}) (bool, string) {
	if serverAuthorized {
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

func (s *Server) canOperate(serverAuthorized bool, runtimeSessionID string) bool {
	return s.cfg.Enabled || serverAuthorized
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
