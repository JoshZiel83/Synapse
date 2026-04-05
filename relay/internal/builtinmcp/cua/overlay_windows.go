//go:build windows && desktop_cua

package cua

import (
	"fmt"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wsPopup           = 0x80000000
	wsExTopmost       = 0x00000008
	wsExToolWindow    = 0x00000080
	wsExTransparent   = 0x00000020
	wsExLayered       = 0x00080000
	wsExNoActivate    = 0x08000000
	lwaAlpha          = 0x00000002
	wmPaint           = 0x000F
	wmEraseBkgnd      = 0x0014
	wmClose           = 0x0010
	wmDestroy         = 0x0002
	wmTimer           = 0x0113
	wmHotKey          = 0x0312
	wmDisplayChange   = 0x007E
	dtCenter          = 0x00000001
	dtVCenter         = 0x00000004
	dtSingleLine      = 0x00000020
	dtNoPrefix        = 0x00000800
	modAlt            = 0x0001
	modControl        = 0x0002
	modShift          = 0x0004
	vkEscape          = 0x1B
	vkBack            = 0x08
	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCXVirtualScreen = 78
	smCYVirtualScreen = 79
	swpNoSize         = 0x0001
	swpNoMove         = 0x0002
	swpNoActivate     = 0x0010
	swpShowWindow     = 0x0040
	swHide            = 0
	swShowNoActivate  = 4
	transparentBkMode = 1
	defaultGUIFont    = 17
	hotkeyTerminateID = 1
	hotkeyDisableID   = 2
	overlayTimerID    = 1
	overlayTimerMs    = 16
	overlayAlpha      = 224
	wdaExcludeCapture = 0x00000011
	wmOverlayCommand  = 0x8001
	wmOverlayUpdate   = 0x8002
	hwndTopmost       = ^uintptr(0)
	hollowBrush       = 5
)

var (
	overlayUser32                       = windows.NewLazySystemDLL("user32.dll")
	overlayGdi32                        = windows.NewLazySystemDLL("gdi32.dll")
	overlayKernel32                     = windows.NewLazySystemDLL("kernel32.dll")
	procOverlayRegisterClassExW         = overlayUser32.NewProc("RegisterClassExW")
	procOverlayCreateWindowExW          = overlayUser32.NewProc("CreateWindowExW")
	procOverlayDefWindowProcW           = overlayUser32.NewProc("DefWindowProcW")
	procOverlayDestroyWindow            = overlayUser32.NewProc("DestroyWindow")
	procOverlayGetMessageW              = overlayUser32.NewProc("GetMessageW")
	procOverlayTranslateMessage         = overlayUser32.NewProc("TranslateMessage")
	procOverlayDispatchMessageW         = overlayUser32.NewProc("DispatchMessageW")
	procOverlayPostQuitMessage          = overlayUser32.NewProc("PostQuitMessage")
	procOverlayPostMessageW             = overlayUser32.NewProc("PostMessageW")
	procOverlayShowWindow               = overlayUser32.NewProc("ShowWindow")
	procOverlaySetWindowPos             = overlayUser32.NewProc("SetWindowPos")
	procOverlaySetLayeredWindowAttrs    = overlayUser32.NewProc("SetLayeredWindowAttributes")
	procOverlayRegisterHotKey           = overlayUser32.NewProc("RegisterHotKey")
	procOverlayUnregisterHotKey         = overlayUser32.NewProc("UnregisterHotKey")
	procOverlayGetSystemMetrics         = overlayUser32.NewProc("GetSystemMetrics")
	procOverlayInvalidateRect           = overlayUser32.NewProc("InvalidateRect")
	procOverlayBeginPaint               = overlayUser32.NewProc("BeginPaint")
	procOverlayEndPaint                 = overlayUser32.NewProc("EndPaint")
	procOverlayFillRect                 = overlayUser32.NewProc("FillRect")
	procOverlayDrawTextW                = overlayUser32.NewProc("DrawTextW")
	procOverlaySetTimer                 = overlayUser32.NewProc("SetTimer")
	procOverlayKillTimer                = overlayUser32.NewProc("KillTimer")
	procOverlaySetWindowDisplayAffinity = overlayUser32.NewProc("SetWindowDisplayAffinity")
	procOverlayGetModuleHandleW         = overlayKernel32.NewProc("GetModuleHandleW")
	procOverlayGetCurrentThreadID       = overlayKernel32.NewProc("GetCurrentThreadId")
	procOverlayCreateSolidBrush         = overlayGdi32.NewProc("CreateSolidBrush")
	procOverlayDeleteObject             = overlayGdi32.NewProc("DeleteObject")
	procOverlayCreatePen                = overlayGdi32.NewProc("CreatePen")
	procOverlaySelectObject             = overlayGdi32.NewProc("SelectObject")
	procOverlayMoveToEx                 = overlayGdi32.NewProc("MoveToEx")
	procOverlayLineTo                   = overlayGdi32.NewProc("LineTo")
	procOverlayEllipse                  = overlayGdi32.NewProc("Ellipse")
	procOverlayPolygon                  = overlayGdi32.NewProc("Polygon")
	procOverlaySetTextColor             = overlayGdi32.NewProc("SetTextColor")
	procOverlaySetBkMode                = overlayGdi32.NewProc("SetBkMode")
	procOverlayGetStockObject           = overlayGdi32.NewProc("GetStockObject")
	overlayWindowsProc                  = windows.NewCallback(windowsOverlayWndProc)
	overlayWindowsControllers           sync.Map
)

type overlayPoint struct {
	X int32
	Y int32
}

type overlayRect struct {
	Left   int32
	Top    int32
	Right  int32
	Bottom int32
}

type overlayPaintStruct struct {
	Hdc       uintptr
	Erase     int32
	PaintRect overlayRect
	Restore   int32
	IncUpdate int32
	Reserved  [32]byte
}

type overlayMsg struct {
	HWnd     uintptr
	Message  uint32
	WParam   uintptr
	LParam   uintptr
	Time     uint32
	Pt       overlayPoint
	LPrivate uint32
}

type overlayWndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSmall  uintptr
}

type windowsOverlayRequest struct {
	run  func() error
	done chan error
}

type windowsOverlayBounds struct {
	Left   int
	Top    int
	Width  int
	Height int
}

type windowsOverlayState struct {
	Visible          bool
	RuntimeSessionID string
	Bounds           windowsOverlayBounds
	Label            string
	Action           string
	UpdatedAt        time.Time
	CurrentScreenX   int
	CurrentScreenY   int
	PreviousScreenX  int
	PreviousScreenY  int
	TrailUntil       time.Time
	PulseCenterX     int
	PulseCenterY     int
	PulseUntil       time.Time
	DragStartX       int
	DragStartY       int
	DragEndX         int
	DragEndY         int
	DragUntil        time.Time
	ScrollCenterX    int
	ScrollCenterY    int
	ScrollDirection  string
	ScrollUntil      time.Time
}

type windowsOverlayController struct {
	hotkeyHandler func(overlayHotkeyAction)

	startOnce sync.Once
	closeOnce sync.Once

	ready    chan error
	done     chan struct{}
	startErr error

	className string
	classPtr  *uint16
	instance  uintptr

	hwnd     atomic.Uintptr
	threadID uint32

	requestSeq atomic.Uint64
	requests   sync.Map

	stateMu sync.Mutex
	state   windowsOverlayState
}

func newStubOverlayController(handler func(overlayHotkeyAction)) overlayController {
	return &windowsOverlayController{
		hotkeyHandler: handler,
		ready:         make(chan error, 1),
		done:          make(chan struct{}),
		state: windowsOverlayState{
			CurrentScreenX:  unsetHUDCoordinate,
			CurrentScreenY:  unsetHUDCoordinate,
			PreviousScreenX: unsetHUDCoordinate,
			PreviousScreenY: unsetHUDCoordinate,
			PulseCenterX:    unsetHUDCoordinate,
			PulseCenterY:    unsetHUDCoordinate,
			DragStartX:      unsetHUDCoordinate,
			DragStartY:      unsetHUDCoordinate,
			DragEndX:        unsetHUDCoordinate,
			DragEndY:        unsetHUDCoordinate,
			ScrollCenterX:   unsetHUDCoordinate,
			ScrollCenterY:   unsetHUDCoordinate,
		},
	}
}

func (w *windowsOverlayController) Start() error {
	w.startOnce.Do(func() {
		go w.run()
		w.startErr = <-w.ready
	})
	return w.startErr
}

func (w *windowsOverlayController) Close() error {
	if err := w.Start(); err != nil {
		return err
	}

	w.closeOnce.Do(func() {
		hwnd := w.hwnd.Load()
		if hwnd != 0 {
			_, _, _ = procOverlayPostMessageW.Call(hwnd, wmClose, 0, 0)
		}
		<-w.done
	})
	return nil
}

func (w *windowsOverlayController) Show(runtimeSessionID string) error {
	if err := w.Start(); err != nil {
		return err
	}
	return w.invoke(func() error {
		bounds := currentWindowsOverlayBounds()
		w.stateMu.Lock()
		w.state.Visible = true
		w.state.RuntimeSessionID = strings.TrimSpace(runtimeSessionID)
		w.state.Bounds = bounds
		w.stateMu.Unlock()

		hwnd := w.hwnd.Load()
		if hwnd == 0 {
			return fmt.Errorf("windows overlay window is unavailable")
		}
		if err := windowsOverlaySetBounds(hwnd, bounds); err != nil {
			return err
		}
		_, _, _ = procOverlayShowWindow.Call(hwnd, swShowNoActivate)
		_, _, _ = procOverlaySetWindowPos.Call(hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate|swpShowWindow)
		_, _, _ = procOverlayInvalidateRect.Call(hwnd, 0, 1)
		return nil
	})
}

func (w *windowsOverlayController) Hide(runtimeSessionID string) {
	if w.Start() != nil {
		return
	}
	_ = w.invoke(func() error {
		hwnd := w.hwnd.Load()
		w.stateMu.Lock()
		if runtimeSessionID == "" || strings.EqualFold(strings.TrimSpace(runtimeSessionID), strings.TrimSpace(w.state.RuntimeSessionID)) {
			w.state.Visible = false
			w.state.RuntimeSessionID = ""
			w.state.Label = ""
			w.state.Action = ""
		}
		w.stateMu.Unlock()
		if hwnd != 0 {
			_, _, _ = procOverlayShowWindow.Call(hwnd, swHide)
		}
		return nil
	})
}

func (w *windowsOverlayController) Update(state actionHUDState) {
	if w.Start() != nil {
		return
	}

	now := time.Now()
	w.stateMu.Lock()
	current := &w.state
	if !current.Visible || !strings.EqualFold(strings.TrimSpace(current.RuntimeSessionID), strings.TrimSpace(state.RuntimeSessionID)) {
		w.stateMu.Unlock()
		return
	}

	current.Label = strings.TrimSpace(state.Label)
	current.Action = strings.TrimSpace(state.Action)
	current.UpdatedAt = now

	if state.ScreenX != unsetHUDCoordinate && state.ScreenY != unsetHUDCoordinate {
		if current.CurrentScreenX != unsetHUDCoordinate && current.CurrentScreenY != unsetHUDCoordinate {
			current.PreviousScreenX = current.CurrentScreenX
			current.PreviousScreenY = current.CurrentScreenY
			current.TrailUntil = now.Add(450 * time.Millisecond)
		}
		current.CurrentScreenX = state.ScreenX
		current.CurrentScreenY = state.ScreenY
	}

	switch state.Action {
	case "click":
		current.PulseCenterX = state.ScreenX
		current.PulseCenterY = state.ScreenY
		current.PulseUntil = now.Add(450 * time.Millisecond)
	case "drag":
		current.DragStartX = state.StartScreenX
		current.DragStartY = state.StartScreenY
		current.DragEndX = state.EndScreenX
		current.DragEndY = state.EndScreenY
		current.DragUntil = now.Add(700 * time.Millisecond)
	case "scroll":
		current.ScrollCenterX = state.ScreenX
		current.ScrollCenterY = state.ScreenY
		current.ScrollDirection = strings.TrimSpace(state.Direction)
		current.ScrollUntil = now.Add(550 * time.Millisecond)
	}
	hwnd := w.hwnd.Load()
	w.stateMu.Unlock()

	if hwnd != 0 {
		_, _, _ = procOverlayPostMessageW.Call(hwnd, wmOverlayUpdate, 0, 0)
	}
}

func (w *windowsOverlayController) CaptureInfo(string) overlayCaptureInfo {
	return overlayCaptureInfo{}
}

func (w *windowsOverlayController) run() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(w.done)

	threadID, _, _ := procOverlayGetCurrentThreadID.Call()
	w.threadID = uint32(threadID)

	instance, _, callErr := procOverlayGetModuleHandleW.Call(0)
	if instance == 0 {
		w.ready <- fmt.Errorf("resolve overlay module handle: %v", callErr)
		return
	}
	w.instance = instance
	w.className = fmt.Sprintf("SynapseRelayCUAOverlay_%d", w.threadID)
	w.classPtr = windows.StringToUTF16Ptr(w.className)

	windowClass := overlayWndClassEx{
		Size:      uint32(unsafe.Sizeof(overlayWndClassEx{})),
		WndProc:   overlayWindowsProc,
		Instance:  instance,
		ClassName: w.classPtr,
	}
	if atom, _, callErr := procOverlayRegisterClassExW.Call(uintptr(unsafe.Pointer(&windowClass))); atom == 0 {
		w.ready <- fmt.Errorf("register overlay window class: %v", callErr)
		return
	}
	defer windowsUnregisterClass(w.classPtr, instance)

	bounds := currentWindowsOverlayBounds()
	hwnd, _, callErr := procOverlayCreateWindowExW.Call(
		wsExLayered|wsExTransparent|wsExNoActivate|wsExToolWindow|wsExTopmost,
		uintptr(unsafe.Pointer(w.classPtr)),
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("Synapse Relay CUA Overlay"))),
		wsPopup,
		uintptr(int32(bounds.Left)),
		uintptr(int32(bounds.Top)),
		uintptr(int32(bounds.Width)),
		uintptr(int32(bounds.Height)),
		0,
		0,
		instance,
		0,
	)
	if hwnd == 0 {
		w.ready <- fmt.Errorf("create overlay window: %v", callErr)
		return
	}
	w.hwnd.Store(hwnd)
	overlayWindowsControllers.Store(hwnd, w)
	defer overlayWindowsControllers.Delete(hwnd)

	if ok, _, callErr := procOverlaySetLayeredWindowAttrs.Call(hwnd, 0, overlayAlpha, lwaAlpha); ok == 0 {
		_, _, _ = procOverlayDestroyWindow.Call(hwnd)
		w.hwnd.Store(0)
		w.ready <- fmt.Errorf("set overlay alpha: %v", callErr)
		return
	}
	if ok, _, callErr := procOverlaySetWindowDisplayAffinity.Call(hwnd, wdaExcludeCapture); ok == 0 {
		_, _, _ = procOverlayDestroyWindow.Call(hwnd)
		w.hwnd.Store(0)
		w.ready <- fmt.Errorf("exclude overlay from capture: %v", callErr)
		return
	}
	if ok, _, callErr := procOverlayRegisterHotKey.Call(hwnd, hotkeyTerminateID, modControl|modAlt|modShift, vkEscape); ok == 0 {
		_, _, _ = procOverlayDestroyWindow.Call(hwnd)
		w.hwnd.Store(0)
		w.ready <- fmt.Errorf("register terminate hotkey: %v", callErr)
		return
	}
	defer procOverlayUnregisterHotKey.Call(hwnd, hotkeyTerminateID)

	if ok, _, callErr := procOverlayRegisterHotKey.Call(hwnd, hotkeyDisableID, modControl|modAlt|modShift, vkBack); ok == 0 {
		_, _, _ = procOverlayDestroyWindow.Call(hwnd)
		w.hwnd.Store(0)
		w.ready <- fmt.Errorf("register disable hotkey: %v", callErr)
		return
	}
	defer procOverlayUnregisterHotKey.Call(hwnd, hotkeyDisableID)

	timerID, _, _ := procOverlaySetTimer.Call(hwnd, overlayTimerID, overlayTimerMs, 0)
	if timerID != 0 {
		defer procOverlayKillTimer.Call(hwnd, overlayTimerID)
	}

	w.ready <- nil

	var message overlayMsg
	for {
		ret, _, _ := procOverlayGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		switch int32(ret) {
		case -1:
			return
		case 0:
			return
		default:
			procOverlayTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
			procOverlayDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
		}
	}
}

func (w *windowsOverlayController) invoke(run func() error) error {
	hwnd := w.hwnd.Load()
	if hwnd == 0 {
		return fmt.Errorf("windows overlay is not running")
	}

	requestID := w.requestSeq.Add(1)
	request := &windowsOverlayRequest{
		run:  run,
		done: make(chan error, 1),
	}
	w.requests.Store(requestID, request)
	if ok, _, callErr := procOverlayPostMessageW.Call(hwnd, wmOverlayCommand, uintptr(requestID), 0); ok == 0 {
		w.requests.Delete(requestID)
		return fmt.Errorf("post overlay command: %v", callErr)
	}

	return <-request.done
}

func (w *windowsOverlayController) handleRequest(requestID uint64) {
	raw, ok := w.requests.LoadAndDelete(requestID)
	if !ok {
		return
	}
	request, ok := raw.(*windowsOverlayRequest)
	if !ok || request == nil {
		return
	}
	request.done <- request.run()
}

func (w *windowsOverlayController) handleHotkey(id int) {
	if w.hotkeyHandler == nil {
		return
	}
	switch id {
	case hotkeyTerminateID:
		go w.hotkeyHandler(overlayHotkeyTerminate)
	case hotkeyDisableID:
		go w.hotkeyHandler(overlayHotkeyDisableBoot)
	}
}

func (w *windowsOverlayController) handleDisplayChange() {
	hwnd := w.hwnd.Load()
	if hwnd == 0 {
		return
	}
	w.stateMu.Lock()
	if !w.state.Visible {
		w.stateMu.Unlock()
		return
	}
	bounds := currentWindowsOverlayBounds()
	w.state.Bounds = bounds
	w.stateMu.Unlock()
	_ = windowsOverlaySetBounds(hwnd, bounds)
}

func (w *windowsOverlayController) snapshotState() windowsOverlayState {
	w.stateMu.Lock()
	defer w.stateMu.Unlock()
	return w.state
}

func (w *windowsOverlayController) paint(hwnd uintptr) uintptr {
	var paint overlayPaintStruct
	hdc, _, _ := procOverlayBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&paint)))
	if hdc == 0 {
		return 0
	}
	defer procOverlayEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&paint)))

	state := w.snapshotState()
	clientRect := overlayRect{}
	clientRect.Left = 0
	clientRect.Top = 0
	clientRect.Right = int32(max(state.Bounds.Width, 0))
	clientRect.Bottom = int32(max(state.Bounds.Height, 0))
	windowsOverlayFillRect(hdc, clientRect, 0x000000)

	if !state.Visible {
		return 0
	}

	now := time.Now()
	windowsOverlayDrawLabel(hdc, clientRect, state.Label)
	windowsOverlayDrawHelp(hdc, clientRect)

	if state.TrailUntil.After(now) && state.PreviousScreenX != unsetHUDCoordinate && state.CurrentScreenX != unsetHUDCoordinate {
		windowsOverlayDrawLine(hdc, state.Bounds, state.PreviousScreenX, state.PreviousScreenY, state.CurrentScreenX, state.CurrentScreenY, 0x7AB8FF, 3)
	}
	if state.DragUntil.After(now) && state.DragStartX != unsetHUDCoordinate && state.DragEndX != unsetHUDCoordinate {
		windowsOverlayDrawLine(hdc, state.Bounds, state.DragStartX, state.DragStartY, state.DragEndX, state.DragEndY, 0xFFD35A, 4)
	}
	if state.CurrentScreenX != unsetHUDCoordinate && state.CurrentScreenY != unsetHUDCoordinate {
		windowsOverlayDrawCursor(hdc, state.Bounds, state.CurrentScreenX, state.CurrentScreenY)
	}
	if state.PulseUntil.After(now) && state.PulseCenterX != unsetHUDCoordinate {
		elapsed := state.PulseUntil.Sub(now)
		windowsOverlayDrawPulse(hdc, state.Bounds, state.PulseCenterX, state.PulseCenterY, elapsed)
	}
	if state.ScrollUntil.After(now) && state.ScrollCenterX != unsetHUDCoordinate {
		windowsOverlayDrawScroll(hdc, state.Bounds, state.ScrollCenterX, state.ScrollCenterY, state.ScrollDirection)
	}

	return 0
}

func windowsOverlayWndProc(hwnd uintptr, msg uint32, wparam, lparam uintptr) uintptr {
	raw, _ := overlayWindowsControllers.Load(hwnd)
	controller, _ := raw.(*windowsOverlayController)

	switch msg {
	case wmPaint:
		if controller != nil {
			return controller.paint(hwnd)
		}
	case wmEraseBkgnd:
		return 1
	case wmTimer, wmOverlayUpdate:
		_, _, _ = procOverlayInvalidateRect.Call(hwnd, 0, 1)
		return 0
	case wmOverlayCommand:
		if controller != nil {
			controller.handleRequest(uint64(wparam))
		}
		return 0
	case wmDisplayChange:
		if controller != nil {
			controller.handleDisplayChange()
		}
		return 0
	case wmHotKey:
		if controller != nil {
			controller.handleHotkey(int(wparam))
		}
		return 0
	case wmClose:
		procOverlayDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		procOverlayPostQuitMessage.Call(0)
		return 0
	}

	ret, _, _ := procOverlayDefWindowProcW.Call(hwnd, uintptr(msg), wparam, lparam)
	return ret
}

func currentWindowsOverlayBounds() windowsOverlayBounds {
	x, _, _ := procOverlayGetSystemMetrics.Call(smXVirtualScreen)
	y, _, _ := procOverlayGetSystemMetrics.Call(smYVirtualScreen)
	w, _, _ := procOverlayGetSystemMetrics.Call(smCXVirtualScreen)
	h, _, _ := procOverlayGetSystemMetrics.Call(smCYVirtualScreen)
	return windowsOverlayBounds{
		Left:   int(int32(x)),
		Top:    int(int32(y)),
		Width:  max(int(int32(w)), 1),
		Height: max(int(int32(h)), 1),
	}
}

func windowsOverlaySetBounds(hwnd uintptr, bounds windowsOverlayBounds) error {
	if ok, _, callErr := procOverlaySetWindowPos.Call(
		hwnd,
		hwndTopmost,
		uintptr(int32(bounds.Left)),
		uintptr(int32(bounds.Top)),
		uintptr(int32(bounds.Width)),
		uintptr(int32(bounds.Height)),
		swpNoActivate|swpShowWindow,
	); ok == 0 {
		return fmt.Errorf("set overlay bounds: %v", callErr)
	}
	return nil
}

func windowsOverlayFillRect(hdc uintptr, rect overlayRect, rgb uint32) {
	brush, _, _ := procOverlayCreateSolidBrush.Call(uintptr(windowsOverlayColorRef(rgb)))
	if brush == 0 {
		return
	}
	defer procOverlayDeleteObject.Call(brush)
	procOverlayFillRect.Call(hdc, uintptr(unsafe.Pointer(&rect)), brush)
}

func windowsOverlayDrawLabel(hdc uintptr, bounds overlayRect, label string) {
	label = strings.TrimSpace(label)
	if label == "" {
		label = "Remote desktop control is active"
	}

	rect := overlayRect{
		Left:   bounds.Left + 36,
		Top:    bounds.Top + 24,
		Right:  bounds.Right - 36,
		Bottom: bounds.Top + 86,
	}
	windowsOverlayFillRect(hdc, rect, 0x181818)
	windowsOverlayDrawText(hdc, rect, label, 0xF8F8F8)
}

func windowsOverlayDrawHelp(hdc uintptr, bounds overlayRect) {
	rect := overlayRect{
		Left:   bounds.Left + 48,
		Top:    bounds.Bottom - 70,
		Right:  bounds.Right - 48,
		Bottom: bounds.Bottom - 24,
	}
	windowsOverlayFillRect(hdc, rect, 0x111111)
	windowsOverlayDrawText(hdc, rect, "Ctrl+Alt+Shift+Esc stop session    Ctrl+Alt+Shift+Backspace disable remote control until reboot", 0xD7D7D7)
}

func windowsOverlayDrawText(hdc uintptr, rect overlayRect, text string, rgb uint32) {
	if strings.TrimSpace(text) == "" {
		return
	}
	procOverlaySetBkMode.Call(hdc, transparentBkMode)
	procOverlaySetTextColor.Call(hdc, uintptr(windowsOverlayColorRef(rgb)))
	font, _, _ := procOverlayGetStockObject.Call(defaultGUIFont)
	if font != 0 {
		old, _, _ := procOverlaySelectObject.Call(hdc, font)
		defer procOverlaySelectObject.Call(hdc, old)
	}

	content := windows.StringToUTF16(text)
	if len(content) == 0 {
		return
	}
	procOverlayDrawTextW.Call(
		hdc,
		uintptr(unsafe.Pointer(&content[0])),
		uintptr(len(content)-1),
		uintptr(unsafe.Pointer(&rect)),
		dtCenter|dtVCenter|dtSingleLine|dtNoPrefix,
	)
}

func windowsOverlayDrawLine(hdc uintptr, bounds windowsOverlayBounds, fromScreenX, fromScreenY, toScreenX, toScreenY int, rgb uint32, width int) {
	fromX, fromY, ok := windowsOverlayLocalPoint(bounds, fromScreenX, fromScreenY)
	if !ok {
		return
	}
	toX, toY, ok := windowsOverlayLocalPoint(bounds, toScreenX, toScreenY)
	if !ok {
		return
	}
	pen, _, _ := procOverlayCreatePen.Call(0, uintptr(max(width, 1)), uintptr(windowsOverlayColorRef(rgb)))
	if pen == 0 {
		return
	}
	defer procOverlayDeleteObject.Call(pen)
	old, _, _ := procOverlaySelectObject.Call(hdc, pen)
	defer procOverlaySelectObject.Call(hdc, old)
	procOverlayMoveToEx.Call(hdc, uintptr(fromX), uintptr(fromY), 0)
	procOverlayLineTo.Call(hdc, uintptr(toX), uintptr(toY))
}

func windowsOverlayDrawCursor(hdc uintptr, bounds windowsOverlayBounds, screenX, screenY int) {
	localX, localY, ok := windowsOverlayLocalPoint(bounds, screenX, screenY)
	if !ok {
		return
	}
	brush, _, _ := procOverlayCreateSolidBrush.Call(uintptr(windowsOverlayColorRef(0xFFFFFF)))
	if brush == 0 {
		return
	}
	defer procOverlayDeleteObject.Call(brush)
	pen, _, _ := procOverlayCreatePen.Call(0, 1, uintptr(windowsOverlayColorRef(0x0A0A0A)))
	if pen == 0 {
		return
	}
	defer procOverlayDeleteObject.Call(pen)
	oldBrush, _, _ := procOverlaySelectObject.Call(hdc, brush)
	defer procOverlaySelectObject.Call(hdc, oldBrush)
	oldPen, _, _ := procOverlaySelectObject.Call(hdc, pen)
	defer procOverlaySelectObject.Call(hdc, oldPen)

	points := []overlayPoint{
		{X: int32(localX), Y: int32(localY)},
		{X: int32(localX), Y: int32(localY + 24)},
		{X: int32(localX + 7), Y: int32(localY + 18)},
		{X: int32(localX + 12), Y: int32(localY + 31)},
		{X: int32(localX + 17), Y: int32(localY + 29)},
		{X: int32(localX + 12), Y: int32(localY + 16)},
		{X: int32(localX + 21), Y: int32(localY + 16)},
	}
	procOverlayPolygon.Call(hdc, uintptr(unsafe.Pointer(&points[0])), uintptr(len(points)))
}

func windowsOverlayDrawPulse(hdc uintptr, bounds windowsOverlayBounds, screenX, screenY int, remaining time.Duration) {
	localX, localY, ok := windowsOverlayLocalPoint(bounds, screenX, screenY)
	if !ok {
		return
	}
	progress := 1 - (float64(remaining) / float64(450*time.Millisecond))
	radius := 10 + int(progress*28)
	pen, _, _ := procOverlayCreatePen.Call(0, 3, uintptr(windowsOverlayColorRef(0x4FB8FF)))
	if pen == 0 {
		return
	}
	defer procOverlayDeleteObject.Call(pen)
	oldPen, _, _ := procOverlaySelectObject.Call(hdc, pen)
	defer procOverlaySelectObject.Call(hdc, oldPen)
	nullBrush, _, _ := procOverlayGetStockObject.Call(hollowBrush)
	oldBrush, _, _ := procOverlaySelectObject.Call(hdc, nullBrush)
	defer procOverlaySelectObject.Call(hdc, oldBrush)
	procOverlayEllipse.Call(
		hdc,
		uintptr(localX-radius),
		uintptr(localY-radius),
		uintptr(localX+radius),
		uintptr(localY+radius),
	)
}

func windowsOverlayDrawScroll(hdc uintptr, bounds windowsOverlayBounds, screenX, screenY int, direction string) {
	localX, localY, ok := windowsOverlayLocalPoint(bounds, screenX, screenY)
	if !ok {
		return
	}
	rect := overlayRect{
		Left:   int32(localX - 42),
		Top:    int32(localY - 60),
		Right:  int32(localX + 42),
		Bottom: int32(localY - 22),
	}
	windowsOverlayFillRect(hdc, rect, 0x1E1E1E)
	windowsOverlayDrawText(hdc, rect, strings.ToUpper(direction), 0xFFE27A)
}

func windowsOverlayLocalPoint(bounds windowsOverlayBounds, screenX, screenY int) (int, int, bool) {
	if screenX == unsetHUDCoordinate || screenY == unsetHUDCoordinate {
		return 0, 0, false
	}
	return screenX - bounds.Left, screenY - bounds.Top, true
}

func windowsOverlayColorRef(rgb uint32) uint32 {
	r := rgb & 0xFF
	g := (rgb >> 8) & 0xFF
	b := (rgb >> 16) & 0xFF
	return (b << 16) | (g << 8) | r
}

func windowsUnregisterClass(classPtr *uint16, instance uintptr) {
	proc := overlayUser32.NewProc("UnregisterClassW")
	if proc.Find() != nil {
		return
	}
	proc.Call(uintptr(unsafe.Pointer(classPtr)), instance)
}
