package cua

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	deskact "github.com/PekingSpades/DeskAct"
	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/desktopdiag"
)

const cuaBootDisableStateFile = "cua-remote-control-disabled.json"

var errCUAPrivacyScreenUnavailable = errors.New("cua privacy screen is unavailable")
var sessionGuardGOOS = runtime.GOOS

type cuaEventEmitter func(string, string, map[string]interface{})
type cuaSessionTerminator func(string, string)

type bootDisableState struct {
	BootID string `json:"bootId"`
}

type guardedSessionState struct {
	initialized bool
	active      bool
	terminated  bool
}

type sessionGuard struct {
	mu         sync.Mutex
	stateDir   string
	bootID     string
	bootLocked bool
	started    bool

	activeRuntimeSessionID string
	sessions               map[string]*guardedSessionState

	overlay    overlayController
	emit       cuaEventEmitter
	terminator cuaSessionTerminator
}

func newSessionGuard(stateDir string) *sessionGuard {
	guard := &sessionGuard{
		stateDir: stateDir,
		sessions: make(map[string]*guardedSessionState),
	}
	guard.overlay = newOverlayController(guard.handleHotkey)
	guard.loadBootDisableState()
	return guard
}

func (g *sessionGuard) Start() error {
	g.mu.Lock()
	if g.started {
		g.mu.Unlock()
		return nil
	}
	g.started = true
	g.mu.Unlock()
	if g.overlay == nil {
		return nil
	}
	if err := g.overlay.Start(); err != nil {
		g.mu.Lock()
		g.started = false
		g.mu.Unlock()
		return err
	}
	return nil
}

func (g *sessionGuard) Close() error {
	g.mu.Lock()
	if !g.started {
		g.mu.Unlock()
		return nil
	}
	g.started = false
	g.mu.Unlock()
	if g.overlay == nil {
		return nil
	}
	return g.overlay.Close()
}

func (g *sessionGuard) SetEventEmitter(handler cuaEventEmitter) {
	g.mu.Lock()
	g.emit = handler
	g.mu.Unlock()
}

func (g *sessionGuard) SetTerminator(handler cuaSessionTerminator) {
	g.mu.Lock()
	g.terminator = handler
	g.mu.Unlock()
}

func (g *sessionGuard) OpenRuntimeSession(runtimeSessionID string) error {
	runtimeSessionID = strings.TrimSpace(runtimeSessionID)
	if runtimeSessionID == "" {
		return nil
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	if _, exists := g.sessions[runtimeSessionID]; exists {
		return nil
	}
	g.sessions[runtimeSessionID] = &guardedSessionState{initialized: true}
	g.emitLocked("cua_session", "Initialized CUA runtime session", map[string]interface{}{
		"state":            "initialized",
		"runtimeSessionId": runtimeSessionID,
	})
	return nil
}

func (g *sessionGuard) CloseRuntimeSession(runtimeSessionID string) {
	runtimeSessionID = strings.TrimSpace(runtimeSessionID)
	if runtimeSessionID == "" {
		return
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	state, exists := g.sessions[runtimeSessionID]
	if !exists {
		return
	}
	if state.active && g.overlay != nil {
		g.overlay.Hide(runtimeSessionID)
	}
	if g.activeRuntimeSessionID == runtimeSessionID {
		g.activeRuntimeSessionID = ""
	}
	delete(g.sessions, runtimeSessionID)
	g.emitLocked("cua_session", "Closed CUA runtime session", map[string]interface{}{
		"state":            "closed",
		"runtimeSessionId": runtimeSessionID,
	})
}

func (g *sessionGuard) Reset() {
	g.mu.Lock()
	activeRuntimeSessionID := g.activeRuntimeSessionID
	g.activeRuntimeSessionID = ""
	g.sessions = make(map[string]*guardedSessionState)
	g.mu.Unlock()

	if activeRuntimeSessionID != "" && g.overlay != nil {
		g.overlay.Hide(activeRuntimeSessionID)
	}
}

func (g *sessionGuard) BeforeToolCall(runtimeSessionID string) *core.CallResult {
	runtimeSessionID = strings.TrimSpace(runtimeSessionID)
	if runtimeSessionID == "" {
		return nil
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	if g.bootLocked {
		g.emitLocked("cua_session", "CUA remote control is disabled for the current boot", map[string]interface{}{
			"state":            "disabled",
			"runtimeSessionId": runtimeSessionID,
		})
		result := remoteControlDisabledResult()
		return &result
	}

	state, exists := g.sessions[runtimeSessionID]
	if !exists {
		state = &guardedSessionState{initialized: true}
		g.sessions[runtimeSessionID] = state
		g.emitLocked("cua_session", "Initialized CUA runtime session", map[string]interface{}{
			"state":            "initialized",
			"runtimeSessionId": runtimeSessionID,
		})
	}

	if state.terminated {
		result := terminatedSessionResult()
		return &result
	}

	if g.activeRuntimeSessionID != "" && g.activeRuntimeSessionID != runtimeSessionID {
		g.emitLocked("cua_session", "Rejected CUA tool call because another session is active", map[string]interface{}{
			"state":            "rejected",
			"runtimeSessionId": runtimeSessionID,
			"activeSessionId":  g.activeRuntimeSessionID,
			"code":             "cua_device_busy",
		})
		result := busySessionResult()
		return &result
	}

	if !state.active {
		if g.overlay != nil {
			if err := g.overlay.Show(runtimeSessionID); err != nil {
				g.emitLocked("cua_session", "CUA privacy screen is unavailable", map[string]interface{}{
					"state":            "blocked",
					"runtimeSessionId": runtimeSessionID,
					"code":             "cua_privacy_screen_unavailable",
					"error":            err.Error(),
				})
				result := privacyScreenUnavailableResult(err)
				return &result
			}
		}
		state.active = true
		g.activeRuntimeSessionID = runtimeSessionID
		g.emitLocked("cua_session", "Activated CUA runtime session", map[string]interface{}{
			"state":            "active",
			"runtimeSessionId": runtimeSessionID,
		})
	}

	return nil
}

func (g *sessionGuard) CaptureOptions() (deskact.CaptureOptions, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	options := deskact.DefaultCaptureOptions()
	switch sessionGuardGOOS {
	case "windows":
		options.Backend = deskact.CaptureBackendDXGI
	case "darwin":
		options.Backend = deskact.CaptureBackendCGDisplay
		if strings.TrimSpace(g.activeRuntimeSessionID) != "" {
			if g.overlay == nil {
				return options, errCUAPrivacyScreenUnavailable
			}
			info := g.overlay.CaptureInfo(g.activeRuntimeSessionID)
			if len(info.ExcludedWindowIDs) == 0 {
				return options, errCUAPrivacyScreenUnavailable
			}
			options.Backend = deskact.CaptureBackendScreenCaptureKit
			options.ExcludedWindowIDs = append([]uint64(nil), info.ExcludedWindowIDs...)
		}
	}

	return options, nil
}

func (g *sessionGuard) IsTerminated(runtimeSessionID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	state := g.sessions[strings.TrimSpace(runtimeSessionID)]
	return state != nil && state.terminated
}

func (g *sessionGuard) RecordAction(state actionHUDState) {
	if strings.TrimSpace(state.RuntimeSessionID) == "" {
		return
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	current := g.sessions[state.RuntimeSessionID]
	if current == nil || !current.active {
		return
	}
	if g.overlay != nil {
		g.overlay.Update(state)
	}
	g.emitLocked("cua_action", state.Label, map[string]interface{}{
		"runtimeSessionId": state.RuntimeSessionID,
		"action":           state.Action,
		"label":            state.Label,
		"displayIndex":     state.DisplayIndex,
		"x":                state.X,
		"y":                state.Y,
		"screenX":          state.ScreenX,
		"screenY":          state.ScreenY,
		"startX":           state.StartX,
		"startY":           state.StartY,
		"endX":             state.EndX,
		"endY":             state.EndY,
		"startScreenX":     state.StartScreenX,
		"startScreenY":     state.StartScreenY,
		"endScreenX":       state.EndScreenX,
		"endScreenY":       state.EndScreenY,
		"textLength":       state.TextLength,
		"keys":             state.Keys,
		"button":           state.Button,
		"clickCount":       state.ClickCount,
		"direction":        state.Direction,
		"amount":           state.Amount,
	})
}

func (g *sessionGuard) loadBootDisableState() {
	if strings.TrimSpace(g.stateDir) == "" {
		return
	}
	bootID, err := desktopdiag.CurrentBootID()
	if err != nil {
		return
	}
	g.bootID = strings.TrimSpace(bootID)

	path := filepath.Join(g.stateDir, cuaBootDisableStateFile)
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	var state bootDisableState
	if json.Unmarshal(data, &state) != nil {
		_ = os.Remove(path)
		return
	}
	if strings.TrimSpace(state.BootID) == "" || state.BootID != g.bootID {
		_ = os.Remove(path)
		return
	}
	g.bootLocked = true
}

func (g *sessionGuard) persistBootDisableState() {
	if strings.TrimSpace(g.stateDir) == "" || strings.TrimSpace(g.bootID) == "" {
		return
	}
	_ = os.MkdirAll(g.stateDir, 0o755)
	payload, err := json.Marshal(bootDisableState{BootID: g.bootID})
	if err != nil {
		return
	}
	target := filepath.Join(g.stateDir, cuaBootDisableStateFile)
	temp := target + ".tmp"
	if err := os.WriteFile(temp, payload, 0o644); err != nil {
		return
	}
	_ = os.Rename(temp, target)
}

func (g *sessionGuard) handleHotkey(action overlayHotkeyAction) {
	var (
		runtimeSessionID string
		terminator       cuaSessionTerminator
		reason           string
	)

	g.mu.Lock()
	if action == overlayHotkeyDisableBoot {
		g.bootLocked = true
		g.persistBootDisableState()
	}

	runtimeSessionID = g.activeRuntimeSessionID
	if runtimeSessionID != "" {
		if state := g.sessions[runtimeSessionID]; state != nil {
			state.active = false
			state.terminated = true
		}
		g.activeRuntimeSessionID = ""
		if g.overlay != nil {
			g.overlay.Hide(runtimeSessionID)
		}
		reason = "user_terminated"
		if action == overlayHotkeyDisableBoot {
			reason = "boot_disabled"
		}
		g.emitLocked("cua_session", "Terminated CUA runtime session from hotkey", map[string]interface{}{
			"state":            "terminated",
			"runtimeSessionId": runtimeSessionID,
			"reason":           reason,
		})
		terminator = g.terminator
	}
	g.mu.Unlock()

	if runtimeSessionID != "" && terminator != nil {
		terminator(runtimeSessionID, reason)
	}
}

func (g *sessionGuard) emitLocked(eventType, message string, data map[string]interface{}) {
	if g.emit == nil {
		return
	}
	g.emit(eventType, message, data)
}

func remoteControlDisabledResult() core.CallResult {
	message := "This computer will not accept more remote desktop actions until the next reboot."
	return core.CallResult{
		Content: []interface{}{core.Text(message)},
		StructuredContent: map[string]interface{}{
			"code":                   "cua_remote_control_disabled",
			"requires_user_approval": true,
			"message":                message,
		},
		IsError: true,
	}
}

func busySessionResult() core.CallResult {
	message := "其他Agent正在使用电脑，请稍后重试。"
	return core.CallResult{
		Content: []interface{}{core.Text(message)},
		StructuredContent: map[string]interface{}{
			"code":    "cua_device_busy",
			"message": message,
		},
		IsError: true,
	}
}

func terminatedSessionResult() core.CallResult {
	message := "This remote desktop session was terminated by the user. Confirm device state with the user before continuing."
	return core.CallResult{
		Content: []interface{}{core.Text(message)},
		StructuredContent: map[string]interface{}{
			"code":    "operation_cancelled",
			"message": message,
		},
		IsError: true,
	}
}

func privacyScreenUnavailableResult(err error) core.CallResult {
	message := "This computer cannot start the protected remote-control overlay required for desktop control. Confirm the local desktop state before retrying."
	if err != nil {
		message = fmt.Sprintf("%s (%v)", message, err)
	}
	return core.CallResult{
		Content: []interface{}{core.Text(message)},
		StructuredContent: map[string]interface{}{
			"code":    "cua_privacy_screen_unavailable",
			"message": message,
		},
		IsError: true,
	}
}

func formatHUDLabel(action string, detail string) string {
	action = strings.TrimSpace(action)
	detail = strings.TrimSpace(detail)
	switch {
	case action == "":
		return detail
	case detail == "":
		return action
	default:
		return fmt.Sprintf("%s: %s", action, detail)
	}
}
