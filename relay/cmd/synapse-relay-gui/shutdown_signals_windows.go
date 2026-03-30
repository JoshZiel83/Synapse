//go:build windows

package main

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"
)

const (
	wmClose           = 0x0010
	wmQuit            = 0x0012
	wmQueryEndSession = 0x0011
	wmEndSession      = 0x0016
)

var (
	user32                 = syscall.NewLazyDLL("user32.dll")
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procCreateWindowExW    = user32.NewProc("CreateWindowExW")
	procDefWindowProcW     = user32.NewProc("DefWindowProcW")
	procDestroyWindow      = user32.NewProc("DestroyWindow")
	procDispatchMessageW   = user32.NewProc("DispatchMessageW")
	procGetMessageW        = user32.NewProc("GetMessageW")
	procPostMessageW       = user32.NewProc("PostMessageW")
	procPostThreadMessageW = user32.NewProc("PostThreadMessageW")
	procRegisterClassExW   = user32.NewProc("RegisterClassExW")
	procTranslateMessage   = user32.NewProc("TranslateMessage")
	procUnregisterClassW   = user32.NewProc("UnregisterClassW")
	procGetModuleHandleW   = kernel32.NewProc("GetModuleHandleW")
	procGetCurrentThreadId = kernel32.NewProc("GetCurrentThreadId")

	globalWindowsShutdownMonitor atomic.Pointer[windowsShutdownMonitor]
	globalWindowsWndProc         = syscall.NewCallback(windowsShutdownWndProc)
)

type point struct {
	X int32
	Y int32
}

type msg struct {
	HWnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
}

type wndClassEx struct {
	CbSize        uint32
	Style         uint32
	LpfnWndProc   uintptr
	CbClsExtra    int32
	CbWndExtra    int32
	HInstance     uintptr
	HIcon         uintptr
	HCursor       uintptr
	HbrBackground uintptr
	LpszMenuName  *uint16
	LpszClassName *uint16
	HIconSm       uintptr
}

type windowsShutdownMonitor struct {
	onSignal  func(string)
	className *uint16
	hInstance uintptr
	hwnd      uintptr
	threadID  uint32
	stopOnce  sync.Once
	fireOnce  sync.Once
	ready     chan error
	stopped   chan struct{}
}

func watchShutdownSignals(ctx context.Context, onSignal func(string)) func() {
	monitor := &windowsShutdownMonitor{
		onSignal: onSignal,
		ready:    make(chan error, 1),
		stopped:  make(chan struct{}),
	}

	go monitor.run()

	var startErr error
	select {
	case startErr = <-monitor.ready:
	case <-ctx.Done():
		startErr = ctx.Err()
	}
	if startErr != nil {
		return func() {}
	}

	go func() {
		<-ctx.Done()
		monitor.stop()
	}()

	return monitor.stop
}

func (m *windowsShutdownMonitor) run() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(m.stopped)

	threadID, _, _ := procGetCurrentThreadId.Call()
	m.threadID = uint32(threadID)

	instance, _, callErr := procGetModuleHandleW.Call(0)
	if instance == 0 {
		m.ready <- fmt.Errorf("get module handle: %v", callErr)
		return
	}
	m.hInstance = instance

	className, err := syscall.UTF16PtrFromString(fmt.Sprintf("SynapseRelayShutdownMonitor-%d", m.threadID))
	if err != nil {
		m.ready <- fmt.Errorf("encode shutdown monitor class name: %w", err)
		return
	}
	m.className = className

	class := wndClassEx{
		CbSize:        uint32(unsafe.Sizeof(wndClassEx{})),
		LpfnWndProc:   globalWindowsWndProc,
		HInstance:     m.hInstance,
		LpszClassName: m.className,
	}
	atom, _, callErr := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class)))
	if atom == 0 {
		m.ready <- fmt.Errorf("register shutdown monitor window class: %v", callErr)
		return
	}
	defer procUnregisterClassW.Call(uintptr(unsafe.Pointer(m.className)), m.hInstance)

	globalWindowsShutdownMonitor.Store(m)
	defer globalWindowsShutdownMonitor.Store(nil)

	hwnd, _, callErr := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(m.className)),
		uintptr(unsafe.Pointer(m.className)),
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		m.hInstance,
		0,
	)
	if hwnd == 0 {
		m.ready <- fmt.Errorf("create shutdown monitor window: %v", callErr)
		return
	}
	m.hwnd = hwnd
	m.ready <- nil

	var message msg
	for {
		result, _, callErr := procGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		switch int32(result) {
		case -1:
			if callErr != syscall.Errno(0) {
				return
			}
			return
		case 0:
			return
		default:
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
		}
	}
}

func (m *windowsShutdownMonitor) stop() {
	if m == nil {
		return
	}
	m.stopOnce.Do(func() {
		if m.hwnd != 0 {
			procPostMessageW.Call(m.hwnd, wmClose, 0, 0)
		}
		if m.threadID != 0 {
			procPostThreadMessageW.Call(uintptr(m.threadID), wmQuit, 0, 0)
		}
		<-m.stopped
	})
}

func (m *windowsShutdownMonitor) fire(signalName string) {
	if m == nil || m.onSignal == nil {
		return
	}
	m.fireOnce.Do(func() {
		m.onSignal(signalName)
	})
}

func windowsShutdownWndProc(hwnd uintptr, msg uint32, wparam, lparam uintptr) uintptr {
	monitor := globalWindowsShutdownMonitor.Load()
	switch msg {
	case wmQueryEndSession:
		if monitor != nil {
			monitor.fire("windows_query_end_session")
		}
		return 1
	case wmEndSession:
		if wparam != 0 && monitor != nil {
			monitor.fire("windows_session_end")
		}
		return 0
	case wmClose:
		procDestroyWindow.Call(hwnd)
		return 0
	default:
		ret, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wparam, lparam)
		return ret
	}
}
