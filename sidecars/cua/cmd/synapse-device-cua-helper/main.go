// synapse-device-cua-helper — Go sidecar binary that exposes CUA primitives
// (display enumeration, screenshot, mouse click, text typing, per-window
// equivalents) to the TypeScript device runtime via JSON-RPC over stdio.
// Per docs/device-runtime-v3.md §5.2 / §10.4 the runtime supervises this
// binary as a child process.
//
// Protocol: JSON-RPC 2.0, newline-delimited, over stdin/stdout. Every request
// carries an optional `session_id` (the server-signed cua_focus_scope_id;
// "default" for loopback smoke tests) that keys per-Agent CUA focus state in
// the focusStore. Methods:
//
//   Legacy (kept for backwards compatibility):
//     hello              -> capability advertisement
//     list_displays      -> { displays: [...] }
//     capture_display    -> { png_base64, width, height }
//     click              -> { ok: true }       (focus-aware in v3)
//     type_text          -> { ok: true, ... }  (focus-aware in v3)
//     shutdown           -> { ok: true }; helper exits 0
//
//   Focus-aware (new):
//     list_windows       -> { windows: [...] }
//     set_focus          -> { coordinate_space, generation, target, ... }
//     get_focus          -> { coordinate_space, generation, target, ... }
//     capture_view       -> { png_base64, width, height, coordinate_space,
//                              generation, target, backend_used, partial, ... }
//
// Errors return JSON-RPC numeric codes; the structured `data` block carries
// `synapse_code` (mapped by TS cua.ts to SynapseError.code), `cua_error`
// (machine-readable enum), and per-call diagnostic fields (backend_used,
// fallback_reason, etc.). See decision 3/6 in
// ~/.claude/plans/synapse-device-runtime-cua-eager-conway.md.

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"log/slog"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	deskact "github.com/PekingSpades/DeskAct"
	"github.com/PekingSpades/DeskAct/display"
	"github.com/PekingSpades/DeskAct/keyboard"
	"github.com/PekingSpades/DeskAct/mouse"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkresource "go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	oteltrace "go.opentelemetry.io/otel/trace"
)

const version = "0.2.0-cua-session-focus"

// store is process-global because the helper is single-tenant per device
// runtime. Bouncing the binary resets focus state (acceptable: runtime
// reconnection rebuilds it via cua_set_focus anyway).
var store = newFocusStore()

// ─── JSON-RPC framing ──────────────────────────────────────────────────────

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	// W3C {traceparent, tracestate?} carrier injected per-RPC by the
	// device-runtime (trace plan §3c) so this helper's span continues the
	// originating request's trace. tracestate rides along so vendor members
	// survive this hop.
	Traceparent string `json:"traceparent,omitempty"`
	Tracestate  string `json:"tracestate,omitempty"`
}

// ─── §3c carrier contract (sanctioned literal duplicate) ────────────────────
//
// Canonical artifact: `packages/shared/src/utils/traceparent.ts` — this file
// is one of the sanctioned duplicates on that artifact's sync list. The
// contract pinned there (mirror any change byte-for-byte):
//
//	TRACEPARENT_RE = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/
//	MAX_TRACESTATE_LENGTH = 1024
//
// Go's regexp (RE2) has no lookahead, so the shape is compiled without the
// all-zero guards and validTraceparent rejects the all-zero trace-id/span-id
// explicitly. Receiver rule (§3c): a malformed/oversized value degrades to
// ABSENT (root span); tracestate is honored only alongside a valid
// traceparent and only up to maxTracestateLength.
const maxTracestateLength = 1024

var traceparentShapeRe = regexp.MustCompile(
	`^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$`,
)

func validTraceparent(value string) bool {
	if !traceparentShapeRe.MatchString(value) {
		return false
	}
	return value[3:35] != "00000000000000000000000000000000" &&
		value[36:52] != "0000000000000000"
}

// frameCarrier builds the W3C extract carrier for a frame's {traceparent,
// tracestate?} pair per the §3c receiver rule: nil when the traceparent is
// malformed (the caller degrades to a root span; the frame is never rejected
// for a trace field), and tracestate rides along only alongside a valid
// traceparent, non-empty and within maxTracestateLength. Unit-tested in
// trace_test.go (mirrors the fs-helper telemetry.rs matrix).
func frameCarrier(traceparent, tracestate string) propagation.MapCarrier {
	if !validTraceparent(traceparent) {
		return nil
	}
	carrier := propagation.MapCarrier{"traceparent": traceparent}
	if tracestate != "" && len(tracestate) <= maxTracestateLength {
		carrier["tracestate"] = tracestate
	}
	return carrier
}

type rpcError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

type rpcResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id,omitempty"`
	Result  interface{} `json:"result,omitempty"`
	Error   *rpcError   `json:"error,omitempty"`
}

func writeResponse(w io.Writer, id interface{}, result interface{}, err *rpcError) {
	resp := rpcResponse{JSONRPC: "2.0", ID: id, Result: result, Error: err}
	data, _ := json.Marshal(resp)
	fmt.Fprintln(w, string(data))
}

// JSON-RPC error code constants. -32602 is "Invalid params" (well-formed but
// semantically wrong); -32000 is implementation-defined "server error".
const (
	codeInvalidParams = -32602
	codeServerError   = -32000
)

// makeError builds an rpcError with a structured `data` block. cuaError is
// a stable string enum the device-runtime TS layer can branch on, and
// synapseCode is the canonical SynapseError code TS should surface
// (constrained to DEVICE_MCP_ERROR_CODES on the TS side).
func makeError(
	rpcCode int,
	message string,
	cuaError string,
	synapseCode string,
	extra map[string]interface{},
) *rpcError {
	data := map[string]interface{}{
		"cua_error":    cuaError,
		"synapse_code": synapseCode,
	}
	for k, v := range extra {
		data[k] = v
	}
	return &rpcError{Code: rpcCode, Message: message, Data: data}
}

// wrapDeskActError translates a raw deskact error into a structured rpcError,
// preferring sentinel-specific codes when possible. DeskAct wraps sentinels
// with fmt.Errorf("%w: ...") on every platform (see screenshot/
// capture_window_darwin.go:125 etc.), so we MUST use errors.Is — a direct
// equality check would miss every wrapped error and silently downgrade them
// to operation_failed / runtime_constraint.
func wrapDeskActError(op string, err error, extra map[string]interface{}) *rpcError {
	if err == nil {
		return nil
	}
	cuaErr := "operation_failed"
	synapseCode := "runtime_constraint"
	switch {
	case errors.Is(err, deskact.ErrCaptureUnsupported):
		cuaErr = "unsupported"
		synapseCode = "runtime_constraint"
	case errors.Is(err, deskact.ErrCaptureWindowNotFound):
		cuaErr = "window_not_found"
		synapseCode = "invalid_request"
	case errors.Is(err, deskact.ErrCapturePermissionDenied):
		cuaErr = "permission_denied"
		synapseCode = "permission_denied"
	case errors.Is(err, deskact.ErrCaptureFailed):
		cuaErr = "capture_failed"
		synapseCode = "runtime_constraint"
	}
	if extra == nil {
		extra = map[string]interface{}{}
	}
	extra["op"] = op
	extra["error_text"] = err.Error()
	return makeError(codeServerError, op+" failed: "+err.Error(), cuaErr, synapseCode, extra)
}

// ─── session_id extraction ─────────────────────────────────────────────────

// sessionIDFromParams pulls the optional `session_id` field out of any
// params object. JSON tag-driven decode keeps the rest of the params handler
// shape intact — we just need to peek at one field.
type sessionEnvelope struct {
	SessionID string `json:"session_id"`
}

func sessionIDFromParams(raw json.RawMessage) string {
	if len(raw) == 0 {
		return defaultSessionID
	}
	var env sessionEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return defaultSessionID
	}
	if env.SessionID == "" {
		return defaultSessionID
	}
	return env.SessionID
}

// ─── window_id parsing ────────────────────────────────────────────────────

func parseWindowID(s string) (uint64, error) {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0, fmt.Errorf("window_id is empty")
	}
	if strings.HasPrefix(t, "0x") || strings.HasPrefix(t, "0X") {
		return strconv.ParseUint(t[2:], 16, 64)
	}
	return strconv.ParseUint(t, 10, 64)
}

func formatWindowIDHex(id uint64) string {
	return fmt.Sprintf("0x%x", id)
}

// ─── per-platform forced backend ──────────────────────────────────────────

// windowCaptureBackend returns the backend whose output coordinate system
// matches ClickWithWindow / UnicodeTypeWithWindow on the current platform.
// Forcing this disables DeskAct's silent fallback (decision 4) so the
// runtime can be sure the screenshot we hand the model uses the same
// coordinate space as subsequent inputs.
func windowCaptureBackend() deskact.CaptureBackend {
	switch runtime.GOOS {
	case "windows":
		return deskact.CaptureBackendPrintWindow
	case "darwin":
		return deskact.CaptureBackendCGWindowList
	case "linux":
		return deskact.CaptureBackendXComposite
	default:
		// Unknown OS: fall back to default and let DeskAct error if it can't.
		return ""
	}
}

// ─── legacy handlers (kept) ────────────────────────────────────────────────

type listDisplaysResult struct {
	Displays []displayInfo `json:"displays"`
}

type displayInfo struct {
	Index  int     `json:"index"`
	ID     int     `json:"id"`
	Width  int     `json:"width"`
	Height int     `json:"height"`
	Scale  float64 `json:"scale"`
	IsMain bool    `json:"is_main"`
}

func handleListDisplays(raw json.RawMessage) (interface{}, *rpcError) {
	store.touch(sessionIDFromParams(raw))
	all := display.AllDisplays(display.DefaultDisplayOptions())
	out := make([]displayInfo, 0, len(all))
	for _, d := range all {
		out = append(out, displayInfo{
			Index:  d.Index(),
			ID:     d.ID(),
			Width:  d.Width(),
			Height: d.Height(),
			Scale:  d.Scale(),
			IsMain: d.IsMain(),
		})
	}
	return listDisplaysResult{Displays: out}, nil
}

type captureDisplayParams struct {
	Index     int    `json:"index"`
	SessionID string `json:"session_id"`
}

type captureDisplayResult struct {
	PNGBase64 string `json:"png_base64"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}

func handleCaptureDisplay(raw json.RawMessage) (interface{}, *rpcError) {
	params := captureDisplayParams{Index: 0}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, makeError(
				codeInvalidParams,
				"invalid capture_display params: "+err.Error(),
				"invalid_params", "invalid_request", nil,
			)
		}
	}
	store.touch(params.SessionID)
	d := display.DisplayAt(params.Index, display.DefaultDisplayOptions())
	if d == nil {
		return nil, makeError(
			codeInvalidParams,
			fmt.Sprintf("display index %d not found", params.Index),
			"display_not_found", "invalid_request",
			map[string]interface{}{"requested_index": params.Index},
		)
	}
	img, err := d.CaptureRect(0, 0, d.Width(), d.Height(), display.DefaultCaptureOptions())
	if err != nil {
		return nil, wrapDeskActError("CaptureRect", err, nil)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, makeError(codeServerError, "PNG encode failed: "+err.Error(),
			"png_encode_failed", "runtime_constraint", nil)
	}
	return captureDisplayResult{
		PNGBase64: base64.StdEncoding.EncodeToString(buf.Bytes()),
		Width:     d.Width(),
		Height:    d.Height(),
	}, nil
}

type clickParams struct {
	X         int    `json:"x"`
	Y         int    `json:"y"`
	Button    string `json:"button"`
	Double    bool   `json:"double"`
	SessionID string `json:"session_id"`
}

func resolveButton(name string) (mouse.MouseButton, *rpcError) {
	switch strings.ToLower(name) {
	case "", "left":
		return mouse.MouseButtonLeft, nil
	case "right":
		return mouse.MouseButtonRight, nil
	case "middle":
		return mouse.MouseButtonCenter, nil
	}
	return mouse.MouseButtonLeft, makeError(
		codeInvalidParams,
		fmt.Sprintf("unsupported mouse button %q", name),
		"invalid_button", "invalid_request",
		map[string]interface{}{"requested_button": name},
	)
}

func handleClick(raw json.RawMessage) (interface{}, *rpcError) {
	var params clickParams
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, makeError(
			codeInvalidParams,
			"invalid click params: "+err.Error(),
			"invalid_params", "invalid_request", nil,
		)
	}
	btn, berr := resolveButton(params.Button)
	if berr != nil {
		return nil, berr
	}
	f := store.get(params.SessionID)
	switch f.Target {
	case focusTargetWindow:
		// Window-pixel coordinates → directed background injection. PID was
		// resolved server-side via ListWindows in set_focus (decision 3) so
		// we never trust an outside-supplied PID at the input point.
		//
		// DeskAct exposes ClickWithWindow but no DoubleClickWithWindow, and
		// MouseSettings has no double-click interval. Emulate double-click
		// by issuing two back-to-back clicks (matches what the display path
		// gets from MoveClick's `double` arg). On the first failure we
		// abort and report the count.
		target := mouse.WindowTarget{WindowID: f.WindowID, PID: f.PID}
		clicks := 1
		if params.Double {
			clicks = 2
		}
		for i := 0; i < clicks; i++ {
			if err := mouse.ClickWithWindow(target, params.X, params.Y, btn, mouse.DefaultMouseSettings()); err != nil {
				return nil, wrapDeskActError("ClickWithWindow", err, map[string]interface{}{
					"window_id":     strconv.FormatUint(f.WindowID, 10),
					"window_id_hex": formatWindowIDHex(f.WindowID),
					"pid":           f.PID,
					"clicks_done":   i,
					"clicks_total":  clicks,
				})
			}
		}
	default:
		// Display-pixel coordinates → translate to absolute then global click.
		d := display.DisplayAt(f.DisplayIndex, display.DefaultDisplayOptions())
		if d == nil {
			return nil, makeError(
				codeServerError,
				fmt.Sprintf("focused display index %d disappeared", f.DisplayIndex),
				"display_not_found", "runtime_constraint",
				map[string]interface{}{"requested_index": f.DisplayIndex},
			)
		}
		ax, ay := d.ToAbsolute(params.X, params.Y)
		if err := mouse.MoveClick(ax, ay, btn, params.Double, mouse.DefaultMouseSettings()); err != nil {
			return nil, wrapDeskActError("MoveClick", err, map[string]interface{}{
				"display_index": f.DisplayIndex,
			})
		}
	}
	return map[string]interface{}{
		"ok":               true,
		"coordinate_space": string(f.CoordinateSpace),
		"generation":       f.Generation,
	}, nil
}

type typeTextParams struct {
	Text      string `json:"text"`
	PID       int    `json:"pid"`
	SessionID string `json:"session_id"`
}

type typeTextResult struct {
	OK              bool   `json:"ok"`
	TypedChars      int    `json:"typed_chars"`
	CoordinateSpace string `json:"coordinate_space"`
	Generation      int64  `json:"generation"`
}

func handleTypeText(raw json.RawMessage) (interface{}, *rpcError) {
	var params typeTextParams
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, makeError(
			codeInvalidParams,
			"invalid type_text params: "+err.Error(),
			"invalid_params", "invalid_request", nil,
		)
	}
	f := store.get(params.SessionID)
	if params.Text == "" {
		return typeTextResult{OK: true, TypedChars: 0, CoordinateSpace: string(f.CoordinateSpace), Generation: f.Generation}, nil
	}
	runes := []rune(params.Text)
	switch f.Target {
	case focusTargetWindow:
		// UnicodeTypeWithWindow accepts one rune per call (DeskAct contract).
		// First failure aborts the loop and surfaces the diagnostic — partial
		// progress is reflected in typed_chars.
		typed := 0
		for _, r := range runes {
			if err := keyboard.UnicodeTypeWithWindow(r, f.WindowID, int(f.PID)); err != nil {
				return nil, wrapDeskActError("UnicodeTypeWithWindow", err, map[string]interface{}{
					"window_id":     strconv.FormatUint(f.WindowID, 10),
					"window_id_hex": formatWindowIDHex(f.WindowID),
					"pid":           f.PID,
					"typed_chars":   typed,
				})
			}
			typed++
		}
		return typeTextResult{OK: true, TypedChars: typed, CoordinateSpace: string(f.CoordinateSpace), Generation: f.Generation}, nil
	default:
		// Display focus uses the global keyboard path with an optional PID
		// hint (preserving legacy semantics). keyboard.Type does not return
		// an error; the caller verifies via a follow-up screenshot.
		keyboard.Type(params.Text, params.PID, keyboard.DefaultKeyboardSettings())
		return typeTextResult{OK: true, TypedChars: len(runes), CoordinateSpace: string(f.CoordinateSpace), Generation: f.Generation}, nil
	}
}

// ─── focus-aware handlers (new) ────────────────────────────────────────────

type windowRect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

func toWindowRect(r deskact.Rect) windowRect {
	return windowRect{X: r.X, Y: r.Y, Width: r.W, Height: r.H}
}

type displayRegionDTO struct {
	DisplayIndex int        `json:"display_index"`
	DisplayID    int        `json:"display_id"`
	PhysicalRect windowRect `json:"physical_rect"`
}

func toDisplayRegions(in []deskact.WindowDisplayRegion) []displayRegionDTO {
	out := make([]displayRegionDTO, 0, len(in))
	for _, r := range in {
		out = append(out, displayRegionDTO{
			DisplayIndex: r.DisplayIndex,
			DisplayID:    r.DisplayID,
			PhysicalRect: toWindowRect(r.PhysicalRect),
		})
	}
	return out
}

type windowDTO struct {
	WindowID       string             `json:"window_id"`
	WindowIDHex    string             `json:"window_id_hex"`
	PID            int                `json:"pid"`
	Title          string             `json:"title"`
	Bounds         windowRect         `json:"bounds"`
	IsVisible      bool               `json:"is_visible"`
	IsMinimized    bool               `json:"is_minimized"`
	DisplayRegions []displayRegionDTO `json:"display_regions"`
	Platform       string             `json:"platform,omitempty"`
}

func toWindowDTO(info deskact.WindowInfo) windowDTO {
	out := windowDTO{
		WindowID:       strconv.FormatUint(info.ID, 10),
		WindowIDHex:    formatWindowIDHex(info.ID),
		PID:            info.PID,
		Title:          info.Title,
		Bounds:         toWindowRect(info.Bounds),
		IsVisible:      info.IsVisible,
		IsMinimized:    info.IsMinimized,
		DisplayRegions: toDisplayRegions(info.DisplayRegions),
	}
	if p := info.GetPlatformInfo(); p != nil {
		out.Platform = p.Platform()
	}
	return out
}

type listWindowsResult struct {
	Windows []windowDTO `json:"windows"`
}

type listWindowsParams struct {
	SessionID string `json:"session_id"`
}

func handleListWindows(raw json.RawMessage) (interface{}, *rpcError) {
	var params listWindowsParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &params)
	}
	store.touch(params.SessionID)
	wins, err := deskact.ListWindows(deskact.DefaultWindowOptions())
	if err != nil {
		return nil, wrapDeskActError("ListWindows", err, nil)
	}
	out := make([]windowDTO, 0, len(wins))
	for _, w := range wins {
		out = append(out, toWindowDTO(w))
	}
	return listWindowsResult{Windows: out}, nil
}

type setFocusParams struct {
	Target       string `json:"target"`
	Mode         string `json:"mode"`
	DisplayIndex *int   `json:"display_index"`
	WindowID     string `json:"window_id"`
	SessionID    string `json:"session_id"`
}

type focusDTO struct {
	Target          string      `json:"target"`
	Mode            string      `json:"mode,omitempty"`
	CoordinateSpace string      `json:"coordinate_space"`
	Generation      int64       `json:"generation"`
	Display         *displayDTO `json:"display,omitempty"`
	Window          *windowDTO  `json:"window,omitempty"`
}

type displayDTO struct {
	Index  int     `json:"index"`
	ID     int     `json:"id"`
	Width  int     `json:"width"`
	Height int     `json:"height"`
	Scale  float64 `json:"scale"`
	IsMain bool    `json:"is_main"`
}

// refreshWindowInfo looks up the current state of the focused window. Returns
// the fresh WindowInfo + true when ListWindows succeeds and the window is
// still present; nil + false otherwise (closed, ListWindows failed,
// unsupported platform, etc.). Callers fall back to the stored focusStore
// snapshot when we can't refresh.
//
// Doing this on every get_focus / capture_view keeps is_visible /
// is_minimized / bounds / title from going stale after the user moves,
// resizes, minimizes, or closes the window between set_focus and the next
// operation. The store-snapshot fields are only the snapshot at set_focus
// time and would otherwise silently mislead the model.
func refreshWindowInfo(windowID uint64) (deskact.WindowInfo, bool) {
	wins, err := deskact.ListWindows(deskact.DefaultWindowOptions())
	if err != nil {
		return deskact.WindowInfo{}, false
	}
	for i := range wins {
		if wins[i].ID == windowID {
			return wins[i], true
		}
	}
	return deskact.WindowInfo{}, false
}

// windowDTOForFocus builds a windowDTO for the currently-focused window,
// preferring fresh data from ListWindows over the focusStore snapshot.
// On refresh miss we emit the snapshot with `is_visible=false` (best-effort
// hint that the window is no longer enumerable) so the model knows it
// cannot rely on bounds / title being current.
func windowDTOForFocus(f sessionFocus) *windowDTO {
	if info, ok := refreshWindowInfo(f.WindowID); ok {
		dto := toWindowDTO(info)
		return &dto
	}
	return &windowDTO{
		WindowID:    strconv.FormatUint(f.WindowID, 10),
		WindowIDHex: formatWindowIDHex(f.WindowID),
		PID:         int(f.PID),
		Title:       f.Title,
		Bounds:      toWindowRect(f.Bounds),
		// Stored snapshot may include display_regions; replay those so
		// multi-display callers still see something.
		DisplayRegions: toDisplayRegions(f.DisplayRegions),
		// IsVisible / IsMinimized intentionally left at their Go zero
		// values (false). A stale-snapshot reader interprets
		// `is_visible:false` as "we could not confirm this window is
		// still enumerable" — true after we successfully refresh.
	}
}

func focusToDTO(f sessionFocus) focusDTO {
	out := focusDTO{
		Target:          string(f.Target),
		Mode:            string(f.Mode),
		CoordinateSpace: string(f.CoordinateSpace),
		Generation:      f.Generation,
	}
	switch f.Target {
	case focusTargetDisplay:
		d := display.DisplayAt(f.DisplayIndex, display.DefaultDisplayOptions())
		if d != nil {
			out.Display = &displayDTO{
				Index:  d.Index(),
				ID:     d.ID(),
				Width:  d.Width(),
				Height: d.Height(),
				Scale:  d.Scale(),
				IsMain: d.IsMain(),
			}
		} else {
			// Best-effort: surface the stored index so the caller can debug a
			// display that vanished between set_focus and get_focus.
			out.Display = &displayDTO{Index: f.DisplayIndex, ID: f.DisplayID}
		}
	case focusTargetWindow:
		out.Window = windowDTOForFocus(f)
	}
	return out
}

func handleSetFocus(raw json.RawMessage) (interface{}, *rpcError) {
	var params setFocusParams
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, makeError(
			codeInvalidParams,
			"invalid set_focus params: "+err.Error(),
			"invalid_params", "invalid_request", nil,
		)
	}
	sessionID := normalizeSessionID(params.SessionID)
	switch params.Target {
	case string(focusTargetDisplay):
		// Default to display 0 when omitted; otherwise validate before touching
		// the store so a bogus index doesn't bump generation / overwrite state.
		idx := 0
		if params.DisplayIndex != nil {
			idx = *params.DisplayIndex
		}
		d := display.DisplayAt(idx, display.DefaultDisplayOptions())
		if d == nil {
			return nil, makeError(
				codeInvalidParams,
				fmt.Sprintf("display index %d not found", idx),
				"display_not_found", "invalid_request",
				map[string]interface{}{"requested_index": idx},
			)
		}
		f := store.setDisplay(sessionID, idx, d.ID())
		return focusToDTO(f), nil
	case string(focusTargetWindow):
		// Phase 1 only supports background mode. Default to background when
		// caller omits it; reject anything else so foreground arrives loudly
		// when Phase 2 ships.
		mode := params.Mode
		if mode == "" {
			mode = string(focusModeBackground)
		}
		if mode != string(focusModeBackground) {
			return nil, makeError(
				codeInvalidParams,
				fmt.Sprintf("unsupported window focus mode %q (Phase 1 only supports 'background')", mode),
				"unsupported_mode", "invalid_request",
				map[string]interface{}{"requested_mode": mode},
			)
		}
		if params.WindowID == "" {
			return nil, makeError(
				codeInvalidParams,
				"window_id is required when target='window'",
				"invalid_params", "invalid_request", nil,
			)
		}
		wid, perr := parseWindowID(params.WindowID)
		if perr != nil {
			return nil, makeError(
				codeInvalidParams,
				"invalid window_id: "+perr.Error(),
				"invalid_params", "invalid_request",
				map[string]interface{}{"requested_window_id": params.WindowID},
			)
		}
		wins, err := deskact.ListWindows(deskact.DefaultWindowOptions())
		if err != nil {
			return nil, wrapDeskActError("ListWindows", err, nil)
		}
		var match *deskact.WindowInfo
		for i := range wins {
			if wins[i].ID == wid {
				match = &wins[i]
				break
			}
		}
		if match == nil {
			return nil, makeError(
				codeInvalidParams,
				fmt.Sprintf("window %s not found", params.WindowID),
				"window_not_found", "invalid_request",
				map[string]interface{}{
					"requested_window_id":     params.WindowID,
					"requested_window_id_hex": formatWindowIDHex(wid),
				},
			)
		}
		f := store.setWindow(sessionID, *match)
		dto := focusToDTO(f)
		// focusToDTO doesn't have full WindowInfo (title etc was already
		// stored), but we kept those fields — DTO covers them. Override with
		// freshly-listed data for is_visible / is_minimized which the store
		// doesn't carry.
		w := toWindowDTO(*match)
		dto.Window = &w
		return dto, nil
	default:
		return nil, makeError(
			codeInvalidParams,
			fmt.Sprintf("unknown target %q (expected 'display' or 'window')", params.Target),
			"invalid_target", "invalid_request",
			map[string]interface{}{"requested_target": params.Target},
		)
	}
}

type getFocusParams struct {
	SessionID string `json:"session_id"`
}

func handleGetFocus(raw json.RawMessage) (interface{}, *rpcError) {
	var params getFocusParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &params)
	}
	f := store.get(params.SessionID)
	return focusToDTO(f), nil
}

type captureViewResult struct {
	PNGBase64       string `json:"png_base64"`
	Width           int    `json:"width"`
	Height          int    `json:"height"`
	CoordinateSpace string `json:"coordinate_space"`
	Generation      int64  `json:"generation"`
	Target          string `json:"target"`
	// Display / Window mirror focusToDTO so the model can confirm "this PNG
	// belongs to display N / window <id> at generation G" without a
	// follow-up cua_get_focus. Especially important when window bounds
	// move/resize or in multi-display setups where coordinate_space alone
	// is ambiguous.
	Display        *displayDTO `json:"display,omitempty"`
	Window         *windowDTO  `json:"window,omitempty"`
	BackendUsed    string      `json:"backend_used,omitempty"`
	Partial        bool        `json:"partial,omitempty"`
	CaptureError   string      `json:"capture_error,omitempty"`
	FallbackReason string      `json:"fallback_reason,omitempty"`
}

type captureViewParams struct {
	SessionID string `json:"session_id"`
}

func handleCaptureView(raw json.RawMessage) (interface{}, *rpcError) {
	var params captureViewParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &params)
	}
	f := store.get(params.SessionID)
	switch f.Target {
	case focusTargetWindow:
		backend := windowCaptureBackend()
		res := deskact.CaptureWindowEx(deskact.CaptureWindowRequest{
			WindowID: f.WindowID,
			PID:      f.PID,
			Options: deskact.CaptureOptions{
				Backend: backend,
			},
		})
		if res.Image == nil {
			// Hard failure — no image to deliver. Surface backend/fallback
			// for diagnosis (decision 4 / 6).
			extra := map[string]interface{}{
				"window_id":         strconv.FormatUint(f.WindowID, 10),
				"window_id_hex":     formatWindowIDHex(f.WindowID),
				"pid":               f.PID,
				"requested_backend": string(backend),
				"backend_used":      string(res.BackendUsed),
			}
			if res.FallbackReason != "" {
				extra["fallback_reason"] = res.FallbackReason
			}
			if res.Err != nil {
				return nil, wrapDeskActError("CaptureWindowEx", res.Err, extra)
			}
			return nil, makeError(
				codeServerError,
				"capture_view returned no image",
				"capture_failed", "runtime_constraint", extra,
			)
		}
		// Image present — may be partial; still deliver so the model has
		// something to work with, but flag it.
		var buf bytes.Buffer
		if err := png.Encode(&buf, res.Image); err != nil {
			return nil, makeError(codeServerError, "PNG encode failed: "+err.Error(),
				"png_encode_failed", "runtime_constraint", nil)
		}
		bounds := res.Image.Bounds()
		// Reuse focusToDTO so display/window metadata stays in lockstep with
		// what cua_get_focus reports. The DTO already pulls fresh DisplayAt
		// info on the display branch and constructs the WindowDTO from the
		// stored focus on the window branch.
		focusDto := focusToDTO(f)
		out := captureViewResult{
			PNGBase64:       base64.StdEncoding.EncodeToString(buf.Bytes()),
			Width:           bounds.Dx(),
			Height:          bounds.Dy(),
			CoordinateSpace: string(f.CoordinateSpace),
			Generation:      f.Generation,
			Target:          string(f.Target),
			Display:         focusDto.Display,
			Window:          focusDto.Window,
			BackendUsed:     string(res.BackendUsed),
			Partial:         res.Partial,
			FallbackReason:  res.FallbackReason,
		}
		if res.Err != nil {
			out.CaptureError = res.Err.Error()
		}
		return out, nil
	default:
		d := display.DisplayAt(f.DisplayIndex, display.DefaultDisplayOptions())
		if d == nil {
			return nil, makeError(
				codeServerError,
				fmt.Sprintf("focused display index %d disappeared", f.DisplayIndex),
				"display_not_found", "runtime_constraint",
				map[string]interface{}{"requested_index": f.DisplayIndex},
			)
		}
		img, err := d.CaptureRect(0, 0, d.Width(), d.Height(), display.DefaultCaptureOptions())
		if err != nil {
			return nil, wrapDeskActError("CaptureRect", err, map[string]interface{}{
				"display_index": f.DisplayIndex,
			})
		}
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			return nil, makeError(codeServerError, "PNG encode failed: "+err.Error(),
				"png_encode_failed", "runtime_constraint", nil)
		}
		focusDto := focusToDTO(f)
		return captureViewResult{
			PNGBase64:       base64.StdEncoding.EncodeToString(buf.Bytes()),
			Width:           d.Width(),
			Height:          d.Height(),
			CoordinateSpace: string(f.CoordinateSpace),
			Generation:      f.Generation,
			Target:          string(f.Target),
			Display:         focusDto.Display,
			Window:          focusDto.Window,
		}, nil
	}
}

// ─── dispatcher ─────────────────────────────────────────────────────────────

var advertisedMethods = []string{
	"list_displays", "capture_display", "click", "type_text",
	"list_windows", "set_focus", "get_focus", "capture_view",
	"shutdown",
}

func handle(line []byte, w io.Writer) {
	var req rpcRequest
	if err := json.Unmarshal(line, &req); err != nil {
		writeResponse(w, nil, nil, &rpcError{Code: -32700, Message: "Parse error"})
		return
	}
	// Per-request span continuing the device-injected {traceparent,
	// tracestate?} carrier (§3c). Validation per the pinned contract below;
	// a malformed carrier degrades to a root span (the frame is never
	// rejected for a trace field), and the propagator re-validates as W3C
	// defense-in-depth.
	if tracer != nil {
		ctx := context.Background()
		if carrier := frameCarrier(req.Traceparent, req.Tracestate); carrier != nil {
			ctx = propagator.Extract(ctx, carrier)
		}
		_, span := tracer.Start(ctx, "cua "+req.Method)
		defer span.End()
	}
	switch req.Method {
	case "hello":
		writeResponse(w, req.ID, map[string]interface{}{
			"version":            version,
			"capability":         "cua",
			"displays_supported": true,
			"focus_supported":    true,
			"methods":            advertisedMethods,
		}, nil)
	case "list_displays":
		result, err := handleListDisplays(req.Params)
		writeResponse(w, req.ID, result, err)
	case "capture_display":
		result, err := handleCaptureDisplay(req.Params)
		writeResponse(w, req.ID, result, err)
	case "click":
		result, err := handleClick(req.Params)
		writeResponse(w, req.ID, result, err)
	case "type_text":
		result, err := handleTypeText(req.Params)
		writeResponse(w, req.ID, result, err)
	case "list_windows":
		result, err := handleListWindows(req.Params)
		writeResponse(w, req.ID, result, err)
	case "set_focus":
		result, err := handleSetFocus(req.Params)
		writeResponse(w, req.ID, result, err)
	case "get_focus":
		result, err := handleGetFocus(req.Params)
		writeResponse(w, req.ID, result, err)
	case "capture_view":
		result, err := handleCaptureView(req.Params)
		writeResponse(w, req.ID, result, err)
	case "shutdown":
		writeResponse(w, req.ID, map[string]interface{}{"ok": true}, nil)
		os.Exit(0)
	default:
		writeResponse(w, req.ID, nil, &rpcError{
			Code:    -32601,
			Message: "Method not found: " + req.Method,
		})
	}
}

// setupLogging configures structured slog output to STDERR only. stdout is the
// JSON-RPC protocol channel and must never carry logs. Level via
// SYNAPSE_DEVICE_LOG_LEVEL (debug|info|warn|error, default info).
//
// NB the old spawn-env trace stamping (SYNAPSE_TRACEPARENT / TRACEPARENT
// echoed on every line) is RETIRED (trace plan §4.G): no writer ever existed,
// and a spawn-time trace stamped on a long-lived helper's logs hours later
// would be actively misleading. Request-scoped trace correlation is the
// per-frame {traceparent, tracestate?} carrier handled in handle().
func setupLogging() {
	level := slog.LevelInfo
	switch strings.ToLower(os.Getenv("SYNAPSE_DEVICE_LOG_LEVEL")) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level})).
		With("service", "cua")
	slog.SetDefault(logger)
}

var tracer oteltrace.Tracer

var propagator = propagation.TraceContext{}

// setupTracing configures OTLP span export (P7), gated on
// OTEL_EXPORTER_OTLP_ENDPOINT. Returns a shutdown func (no-op when disabled).
// stdout stays the JSON-RPC channel; spans go over OTLP/HTTP to the collector.
func setupTracing(ctx context.Context) func(context.Context) error {
	noop := func(context.Context) error { return nil }
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" {
		return noop
	}
	exp, err := otlptracehttp.New(ctx)
	if err != nil {
		slog.Error("otlp trace exporter init failed", "err", err.Error())
		return noop
	}
	name := os.Getenv("OTEL_SERVICE_NAME")
	if name == "" {
		name = "cua"
	}
	res, err := sdkresource.New(
		ctx,
		sdkresource.WithAttributes(
			attribute.String("service.name", name),
			attribute.String("service.namespace", "synapse"),
		),
	)
	if err != nil {
		res = sdkresource.Default()
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagator)
	tracer = tp.Tracer("synapse-cua")
	return tp.Shutdown
}

func main() {
	setupLogging()
	shutdownTracing := setupTracing(context.Background())
	defer func() { _ = shutdownTracing(context.Background()) }()
	slog.Info("cua sidecar starting", "pid", os.Getpid())
	scanner := bufio.NewScanner(os.Stdin)
	// Allow large frames (screenshot payloads etc.).
	scanner.Buffer(make([]byte, 1024*1024), 32*1024*1024)
	for scanner.Scan() {
		handle(scanner.Bytes(), os.Stdout)
	}
	if err := scanner.Err(); err != nil {
		slog.Error("stdin scanner error", "err", err.Error())
	}
	slog.Info("cua sidecar stopping")
}
