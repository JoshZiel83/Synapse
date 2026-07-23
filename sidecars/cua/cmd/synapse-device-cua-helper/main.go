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
	"os/signal"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	deskact "github.com/PekingSpades/DeskAct"
	"github.com/PekingSpades/DeskAct/display"
	"github.com/PekingSpades/DeskAct/keyboard"
	"github.com/PekingSpades/DeskAct/mouse"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkresource "go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
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

// ─── synapse-trace-contract v2 (sanctioned literal duplicate) ───────────────
//
// Canonical artifact: packages/shared/src/utils/traceparent.ts. The guard
// scripts/guard-trace-propagation.mjs (rule carrier_contract_drift) byte-
// compares the two values below against the canonical file and asserts the
// numeric const matches. Mirror any change to the canonical file here:
//
//	TRACEPARENT_RE = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/
//	MAX_TRACESTATE_LENGTH = 512
//
// This helper pins ONLY traceparent + the 512 cap: go.opentelemetry.io/otel's
// ParseTraceState already enforces the tracestate ABNF at Level 1, whole-or-
// nothing, with errDuplicate and a 32-member cap, the moment the propagator
// extracts — so re-implementing the key/value grammar here would be drift for
// no gain. Go's RE2 has no lookahead, so validTraceparent rejects the all-zero
// trace-id/span-id explicitly instead of via (?!0{32}). Receiver rule: a
// malformed/oversized value degrades to ABSENT (root span); tracestate is
// honored only alongside a valid traceparent and only up to maxTracestateLength.
const maxTracestateLength = 512

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
// semantically wrong); -32000 is implementation-defined "server error";
// -32601 "Method not found" is produced by exactly one site (the dispatcher's
// default arm) and is the STRUCTURAL signal recordRPCOutcome uses to classify a
// method as unrecognized (`_OTHER`); -32700 "Parse error" is the malformed-frame
// response.
const (
	codeInvalidParams  = -32602
	codeServerError    = -32000
	codeMethodNotFound = -32601
	codeParseError     = -32700
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
}

// dispatchRPC routes one parsed frame to its handler and RETURNS the outcome
// (result, *rpcError) instead of writing it — so handle() owns the single
// writeResponse + single recordRPCOutcome, and a new method physically cannot
// forget to record its span outcome. The `default` arm is the ONLY producer of
// codeMethodNotFound in this helper (grep-verified), which is what lets
// recordRPCOutcome classify `_OTHER` structurally.
func dispatchRPC(req rpcRequest) (interface{}, *rpcError) {
	switch req.Method {
	case "hello":
		return map[string]interface{}{
			"version":            version,
			"capability":         "cua",
			"displays_supported": true,
			"focus_supported":    true,
			"methods":            advertisedMethods,
		}, nil
	case "list_displays":
		return handleListDisplays(req.Params)
	case "capture_display":
		return handleCaptureDisplay(req.Params)
	case "click":
		return handleClick(req.Params)
	case "type_text":
		return handleTypeText(req.Params)
	case "list_windows":
		return handleListWindows(req.Params)
	case "set_focus":
		return handleSetFocus(req.Params)
	case "get_focus":
		return handleGetFocus(req.Params)
	case "capture_view":
		return handleCaptureView(req.Params)
	default:
		return nil, &rpcError{
			Code:    codeMethodNotFound,
			Message: "Method not found: " + req.Method,
		}
	}
}

func handle(line []byte, w io.Writer) {
	// Parse FIRST, but do NOT return before the span is started — a malformed
	// frame must still produce a span (previously the -32700 path returned
	// before any span existed). Carrier extraction runs only on a parsed frame.
	var req rpcRequest
	parseErr := json.Unmarshal(line, &req)

	// Per-request SERVER span continuing the device-injected {traceparent,
	// tracestate?} carrier (§3c). A malformed carrier degrades to a root span
	// (the frame is never rejected for a trace field); the propagator
	// re-validates as W3C defense-in-depth. `tracer` is the package-level
	// delegating otel.Tracer — a no-op provider until setupTracing installs a
	// real one, so this is always safe to call.
	ctx := context.Background()
	if parseErr == nil {
		if carrier := frameCarrier(req.Traceparent, req.Tracestate); carrier != nil {
			ctx = propagator.Extract(ctx, carrier)
		}
	}
	_, span := tracer.Start(ctx, "jsonrpc",
		oteltrace.WithSpanKind(oteltrace.SpanKindServer),
		oteltrace.WithAttributes(rpcCreateAttrs(req, parseErr)...),
	)
	defer span.End()

	if parseErr != nil {
		perr := &rpcError{Code: codeParseError, Message: "Parse error"}
		writeResponse(w, nil, nil, perr)
		recordRPCOutcome(span, "", parseErr, perr)
		return
	}

	result, rpcErr := dispatchRPC(req)
	writeResponse(w, req.ID, result, rpcErr)
	recordRPCOutcome(span, req.Method, nil, rpcErr)
}

// rpcCreateAttrs are the JSON-RPC span-creation attributes per the semconv
// (Go semconv v1.41.0): rpc.system.name=jsonrpc, jsonrpc.protocol.version=2.0,
// network.transport=pipe, and jsonrpc.request.id ONLY when the parsed frame
// carries an id (notifications and unparsable frames omit it — a null/absent id
// is not captured). rpc.method / rpc.method_original are set later by
// recordRPCOutcome, once the dispatcher has classified the method.
func rpcCreateAttrs(req rpcRequest, parseErr error) []attribute.KeyValue {
	attrs := []attribute.KeyValue{
		semconv.RPCSystemNameJSONRPC,
		semconv.JSONRPCProtocolVersion("2.0"),
		semconv.NetworkTransportPipe,
	}
	if parseErr == nil {
		if id, ok := jsonrpcRequestID(req.ID); ok {
			attrs = append(attrs, semconv.JSONRPCRequestID(id))
		}
	}
	return attrs
}

// jsonrpcRequestID renders a JSON-RPC id (string or number) for the
// jsonrpc.request.id attribute, returning ok=false for a notification (no id)
// so the attribute is OMITTED rather than set to a placeholder. JSON numbers
// decode to float64 without UseNumber; render integer ids without a trailing
// ".0" so id 1 shows as "1".
func jsonrpcRequestID(id interface{}) (string, bool) {
	switch v := id.(type) {
	case nil:
		return "", false
	case string:
		return v, true
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64), true
	case json.Number:
		return v.String(), true
	default:
		return fmt.Sprint(v), true
	}
}

// recordRPCOutcome finishes the RPC span's semantic picture after dispatch: it
// names the span and sets rpc.method for a RECOGNIZED method, or leaves the name
// as "jsonrpc" and sets rpc.method=_OTHER + rpc.method_original (truncated) for
// an unrecognized/unparsable one — so a buggy or hostile parent cannot blow up
// span-name / rpc.method cardinality. On ANY JSON-RPC error object it records
// rpc.response.status_code + error.type (the decimal code as a string) and an
// Error status with the JSON-RPC message; every code counts (-32601/-32602/
// -32700 and the fs-helper family alike — JSON-RPC has no 4xx-stays-Unset
// leniency). Recognition is STRUCTURAL: the dispatcher's default arm is the sole
// -32601 producer, so recognized == parsed && not-Method-not-found.
func recordRPCOutcome(span oteltrace.Span, method string, parseErr error, rpcErr *rpcError) {
	recognized := parseErr == nil && !(rpcErr != nil && rpcErr.Code == codeMethodNotFound)
	if recognized {
		span.SetName(method)
		span.SetAttributes(semconv.RPCMethod(method))
	} else {
		span.SetAttributes(semconv.RPCMethod("_OTHER"))
		if method != "" {
			span.SetAttributes(semconv.RPCMethodOriginal(truncateMethod(method)))
		}
	}
	if rpcErr != nil {
		code := strconv.Itoa(rpcErr.Code)
		span.SetAttributes(
			semconv.RPCResponseStatusCode(code),
			semconv.ErrorTypeKey.String(code),
		)
		span.SetStatus(codes.Error, rpcErr.Message)
	}
}

// truncateMethod bounds an unrecognized method captured as rpc.method_original,
// so an unbounded inbound method string can never bloat the attribute.
func truncateMethod(s string) string {
	const maxMethodOriginal = 128
	if len(s) > maxMethodOriginal {
		return s[:maxMethodOriginal]
	}
	return s
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

// tracer is the package-level delegating tracer: otel.Tracer resolves the
// global provider dynamically, so it is a no-op until setupTracing installs a
// real TracerProvider (and picks one up even if it is set later, e.g. by a
// test) — which is why handle() no longer needs a `tracer != nil` guard.
var tracer = otel.Tracer("synapse-cua")

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
	// `tracer` is the delegating otel.Tracer above; setting the global provider
	// is all it takes for it to start producing real spans.
	return tp.Shutdown
}

func main() {
	setupLogging()
	shutdownTracing := setupTracing(context.Background())
	slog.Info("cua sidecar starting", "pid", os.Getpid())

	// Stop on stdin EOF (supervisor closed our stdin) OR SIGTERM/SIGINT (the
	// device-runtime's stop() signals after an EOF grace). Either way control
	// falls through to a BOUNDED flush of buffered OTLP spans. The old binary
	// installed NO signal handler, so a SIGTERM'd helper — the path
	// packages/device-runtime/src/sidecar.ts actually uses — dropped every
	// buffered span; now signals flush.
	sigCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	done := make(chan struct{})
	go func() {
		defer close(done)
		scanner := bufio.NewScanner(os.Stdin)
		// Allow large frames (screenshot payloads etc.).
		scanner.Buffer(make([]byte, 1024*1024), 32*1024*1024)
		for scanner.Scan() {
			handle(scanner.Bytes(), os.Stdout)
		}
		if err := scanner.Err(); err != nil {
			slog.Error("stdin scanner error", "err", err.Error())
		}
	}()

	select {
	case <-done:
		slog.Info("cua sidecar stopping (stdin closed)")
	case <-sigCtx.Done():
		slog.Info("cua sidecar stopping (signal)")
	}

	// Bounded flush: the 1500 ms ceiling stays strictly inside the supervisor's
	// SIGKILL window (sidecar.ts stopTermGraceMs=2000 after a 2000 ms EOF grace).
	// A dead collector fails fast (connection refused), so this is a ceiling,
	// not a cost.
	flushCtx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	if err := shutdownTracing(flushCtx); err != nil {
		slog.Warn("otel flush on shutdown incomplete", "err", err.Error())
	}
}
