// synapse-device-cua-helper — Go sidecar binary that exposes CUA primitives
// (display enumeration, screenshot, mouse click, text typing) to the
// TypeScript device runtime via JSON-RPC over stdio. Per docs/device-runtime-v3.md
// §5.2 / §10.4 the runtime supervises this binary as a child process.
//
// Protocol: JSON-RPC 2.0, newline-delimited, over stdin/stdout. Methods:
//   hello              -> { version, capability, displays_supported }
//   list_displays      -> { displays: [{ index, width, height, scale, is_main }] }
//   capture_display    -> { png_base64, width, height }
//   click              -> { ok: true }
//   type_text          -> { ok: true, typed_chars }
//   shutdown           -> { ok: true }; helper exits 0
//
// Errors return JSON-RPC -32000 ("CUA error") with a string `data` payload
// pinpointing the DeskAct call that failed.

package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"io"
	"os"
	"strings"

	"github.com/PekingSpades/DeskAct/display"
	"github.com/PekingSpades/DeskAct/keyboard"
	"github.com/PekingSpades/DeskAct/mouse"
)

const version = "0.1.0-device-runtime-v3"

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
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

func cuaError(msg string, cause error) *rpcError {
	data := msg
	if cause != nil {
		data = msg + ": " + cause.Error()
	}
	return &rpcError{Code: -32000, Message: "CUA error", Data: data}
}

// ─── method handlers ────────────────────────────────────────────────────────

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

func handleListDisplays() (interface{}, *rpcError) {
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
	Index int `json:"index"`
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
			return nil, cuaError("invalid capture_display params", err)
		}
	}
	d := display.DisplayAt(params.Index, display.DefaultDisplayOptions())
	if d == nil {
		return nil, cuaError(
			fmt.Sprintf("display index %d not found", params.Index), nil,
		)
	}
	img, err := d.CaptureRect(0, 0, d.Width(), d.Height(), display.DefaultCaptureOptions())
	if err != nil {
		return nil, cuaError("CaptureRect failed", err)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, cuaError("PNG encode failed", err)
	}
	return captureDisplayResult{
		PNGBase64: base64.StdEncoding.EncodeToString(buf.Bytes()),
		Width:     d.Width(),
		Height:    d.Height(),
	}, nil
}

type clickParams struct {
	X      int    `json:"x"`
	Y      int    `json:"y"`
	Button string `json:"button"`
	Double bool   `json:"double"`
}

func handleClick(raw json.RawMessage) (interface{}, *rpcError) {
	var params clickParams
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, cuaError("invalid click params", err)
	}
	btn := mouse.MouseButtonLeft
	switch strings.ToLower(params.Button) {
	case "", "left":
		btn = mouse.MouseButtonLeft
	case "right":
		btn = mouse.MouseButtonRight
	case "middle":
		btn = mouse.MouseButtonCenter
	default:
		return nil, cuaError(
			fmt.Sprintf("unsupported mouse button %q", params.Button), nil,
		)
	}
	if err := mouse.MoveClick(params.X, params.Y, btn, params.Double, mouse.DefaultMouseSettings()); err != nil {
		return nil, cuaError("MoveClick failed", err)
	}
	return map[string]bool{"ok": true}, nil
}

type typeTextParams struct {
	Text string `json:"text"`
	// PID 0 means "do not target a specific process" (DeskAct uses 0 as
	// no-PID sentinel on the platforms that look at this argument).
	PID int `json:"pid"`
}

type typeTextResult struct {
	OK         bool `json:"ok"`
	TypedChars int  `json:"typed_chars"`
}

func handleTypeText(raw json.RawMessage) (interface{}, *rpcError) {
	var params typeTextParams
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, cuaError("invalid type_text params", err)
	}
	if params.Text == "" {
		return typeTextResult{OK: true, TypedChars: 0}, nil
	}
	// keyboard.Type does not return an error; failures surface via DeskAct
	// internal logs. We still report success here since the caller can verify
	// via a follow-up screenshot.
	keyboard.Type(params.Text, params.PID, keyboard.DefaultKeyboardSettings())
	return typeTextResult{OK: true, TypedChars: len([]rune(params.Text))}, nil
}

// ─── dispatcher ─────────────────────────────────────────────────────────────

func handle(line []byte, w io.Writer) {
	var req rpcRequest
	if err := json.Unmarshal(line, &req); err != nil {
		writeResponse(w, nil, nil, &rpcError{Code: -32700, Message: "Parse error"})
		return
	}
	switch req.Method {
	case "hello":
		writeResponse(w, req.ID, map[string]interface{}{
			"version":            version,
			"capability":         "cua",
			"displays_supported": true,
			"methods": []string{
				"list_displays", "capture_display", "click", "type_text", "shutdown",
			},
		}, nil)
	case "list_displays":
		result, err := handleListDisplays()
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

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	// Allow large frames (screenshot payloads etc.).
	scanner.Buffer(make([]byte, 1024*1024), 32*1024*1024)
	for scanner.Scan() {
		handle(scanner.Bytes(), os.Stdout)
	}
}
