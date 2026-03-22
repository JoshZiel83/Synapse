//go:build windows

package tray

import (
	"fmt"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	trayIconID           = 1
	trayCallbackMessage  = 0x8001
	menuItemShow         = 1001
	menuItemExit         = 1002
	nimAdd               = 0x00000000
	nimModify            = 0x00000001
	nimDelete            = 0x00000002
	nimSetVersion        = 0x00000004
	nifMessage           = 0x00000001
	nifIcon              = 0x00000002
	nifTip               = 0x00000004
	nifInfo              = 0x00000010
	notifyIconVersion4   = 4
	niifInfo             = 0x00000001
	niifWarning          = 0x00000002
	wmClose              = 0x0010
	wmDestroy            = 0x0002
	wmNull               = 0x0000
	wmLButtonUp          = 0x0202
	wmLButtonDoubleClick = 0x0203
	wmRButtonUp          = 0x0205
	wmContextMenu        = 0x007B
	tpmRightButton       = 0x0002
	tpmReturnCommand     = 0x0100
	mfString             = 0x00000000
	mfSeparator          = 0x00000800
	idiApplication       = 32512
)

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	shell32                 = windows.NewLazySystemDLL("shell32.dll")
	kernel32                = windows.NewLazySystemDLL("kernel32.dll")
	procRegisterClassExW    = user32.NewProc("RegisterClassExW")
	procCreateWindowExW     = user32.NewProc("CreateWindowExW")
	procDefWindowProcW      = user32.NewProc("DefWindowProcW")
	procDestroyWindow       = user32.NewProc("DestroyWindow")
	procDestroyMenu         = user32.NewProc("DestroyMenu")
	procLoadIconW           = user32.NewProc("LoadIconW")
	procGetMessageW         = user32.NewProc("GetMessageW")
	procTranslateMessage    = user32.NewProc("TranslateMessage")
	procDispatchMessageW    = user32.NewProc("DispatchMessageW")
	procPostQuitMessage     = user32.NewProc("PostQuitMessage")
	procPostMessageW        = user32.NewProc("PostMessageW")
	procCreatePopupMenu     = user32.NewProc("CreatePopupMenu")
	procAppendMenuW         = user32.NewProc("AppendMenuW")
	procTrackPopupMenu      = user32.NewProc("TrackPopupMenu")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procGetCursorPos        = user32.NewProc("GetCursorPos")
	procUnregisterClassW    = user32.NewProc("UnregisterClassW")
	procGetModuleHandleW    = kernel32.NewProc("GetModuleHandleW")
	procShellNotifyIconW    = shell32.NewProc("Shell_NotifyIconW")
	procExtractIconW        = shell32.NewProc("ExtractIconW")
	procDestroyIcon         = user32.NewProc("DestroyIcon")
	trayWindowProc          = windows.NewCallback(windowsTrayProc)
	trayManagers            sync.Map
)

type point struct {
	X int32
	Y int32
}

type msg struct {
	HWnd     uintptr
	Message  uint32
	WParam   uintptr
	LParam   uintptr
	Time     uint32
	Pt       point
	LPrivate uint32
}

type wndClassEx struct {
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

type notifyIconData struct {
	Size             uint32
	HWnd             uintptr
	ID               uint32
	Flags            uint32
	CallbackMessage  uint32
	Icon             uintptr
	Tip              [128]uint16
	State            uint32
	StateMask        uint32
	Info             [256]uint16
	TimeoutOrVersion uint32
	InfoTitle        [64]uint16
	InfoFlags        uint32
	GuidItem         windows.GUID
	BalloonIcon      uintptr
}

type windowsTray struct {
	appName   string
	onOpen    func()
	onExit    func()
	className string
	classPtr  *uint16
	instance  uintptr
	hwnd      atomic.Uintptr
	menu      atomic.Uintptr
	icon      atomic.Uintptr
	available atomic.Bool
	closeOnce sync.Once
	done      chan struct{}
}

func newManager(appName string, onOpen func(), onExit func()) (Manager, error) {
	manager := &windowsTray{
		appName: appName,
		onOpen:  onOpen,
		onExit:  onExit,
		done:    make(chan struct{}),
	}

	ready := make(chan error, 1)
	go manager.run(ready)

	if err := <-ready; err != nil {
		return nil, err
	}
	return manager, nil
}

func (w *windowsTray) run(ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(w.done)

	if err := w.initialise(); err != nil {
		ready <- err
		return
	}
	ready <- nil

	var message msg
	for {
		ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		switch int32(ret) {
		case -1:
			w.cleanup()
			return
		case 0:
			w.cleanup()
			return
		default:
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
		}
	}
}

func (w *windowsTray) initialise() error {
	instance, _, err := procGetModuleHandleW.Call(0)
	if instance == 0 {
		return fmt.Errorf("resolve module handle: %w", err)
	}
	w.instance = instance

	w.className = fmt.Sprintf("SynapseRelayTray_%d", os.Getpid())
	w.classPtr = windows.StringToUTF16Ptr(w.className)

	iconHandle := w.loadIcon()
	w.icon.Store(iconHandle)

	windowClass := wndClassEx{
		Size:      uint32(unsafe.Sizeof(wndClassEx{})),
		WndProc:   trayWindowProc,
		Instance:  instance,
		Icon:      iconHandle,
		IconSmall: iconHandle,
		ClassName: w.classPtr,
	}

	if atom, _, callErr := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&windowClass))); atom == 0 {
		return fmt.Errorf("register tray window class: %w", callErr)
	}

	title := windows.StringToUTF16Ptr(w.appName)
	hwnd, _, callErr := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(w.classPtr)),
		uintptr(unsafe.Pointer(title)),
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		instance,
		0,
	)
	if hwnd == 0 {
		w.cleanup()
		return fmt.Errorf("create tray window: %w", callErr)
	}

	menu, _, callErr := procCreatePopupMenu.Call()
	if menu == 0 {
		_, _, _ = procDestroyWindow.Call(hwnd)
		w.cleanup()
		return fmt.Errorf("create tray menu: %w", callErr)
	}

	_, _, _ = procAppendMenuW.Call(menu, mfString, menuItemShow, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("Open"))))
	_, _, _ = procAppendMenuW.Call(menu, mfSeparator, 0, 0)
	_, _, _ = procAppendMenuW.Call(menu, mfString, menuItemExit, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("Quit"))))

	w.hwnd.Store(hwnd)
	w.menu.Store(menu)
	trayManagers.Store(hwnd, w)

	nid := notifyIconData{
		Size:            uint32(unsafe.Sizeof(notifyIconData{})),
		HWnd:            hwnd,
		ID:              trayIconID,
		Flags:           nifMessage | nifIcon | nifTip,
		CallbackMessage: trayCallbackMessage,
		Icon:            iconHandle,
	}
	copyUTF16(nid.Tip[:], w.appName)

	if !shellNotifyIcon(nimAdd, &nid) {
		trayManagers.Delete(hwnd)
		_, _, _ = procDestroyMenu.Call(menu)
		_, _, _ = procDestroyWindow.Call(hwnd)
		w.cleanup()
		return fmt.Errorf("add tray icon: shell notify icon failed")
	}

	nid.TimeoutOrVersion = notifyIconVersion4
	shellNotifyIcon(nimSetVersion, &nid)
	w.available.Store(true)
	return nil
}

func (w *windowsTray) loadIcon() uintptr {
	executable, err := os.Executable()
	if err == nil {
		if icon := extractIcon(executable); icon != 0 {
			return icon
		}
	}

	icon, _, _ := procLoadIconW.Call(0, idiApplication)
	return icon
}

func (w *windowsTray) cleanup() {
	if hwnd := w.hwnd.Swap(0); hwnd != 0 {
		trayManagers.Delete(hwnd)
	}
	if menu := w.menu.Swap(0); menu != 0 {
		_, _, _ = procDestroyMenu.Call(menu)
	}
	if icon := w.icon.Swap(0); icon != 0 {
		_, _, _ = procDestroyIcon.Call(icon)
	}
	if w.classPtr != nil && w.instance != 0 {
		_, _, _ = procUnregisterClassW.Call(uintptr(unsafe.Pointer(w.classPtr)), w.instance)
	}
	w.available.Store(false)
}

func (w *windowsTray) Available() bool {
	return w.available.Load() && w.hwnd.Load() != 0
}

func (w *windowsTray) Close() error {
	w.closeOnce.Do(func() {
		if hwnd := w.hwnd.Load(); hwnd != 0 {
			_, _, _ = procPostMessageW.Call(hwnd, wmClose, 0, 0)
		}
	})
	<-w.done
	return nil
}

func (w *windowsTray) ShowNotification(title, message string, warning bool) error {
	if !w.Available() {
		return nil
	}

	nid := notifyIconData{
		Size:  uint32(unsafe.Sizeof(notifyIconData{})),
		HWnd:  w.hwnd.Load(),
		ID:    trayIconID,
		Flags: nifInfo,
	}
	copyUTF16(nid.InfoTitle[:], title)
	copyUTF16(nid.Info[:], message)
	if warning {
		nid.InfoFlags = niifWarning
	} else {
		nid.InfoFlags = niifInfo
	}

	if !shellNotifyIcon(nimModify, &nid) {
		return fmt.Errorf("show tray notification: shell notify icon failed")
	}
	return nil
}

func (w *windowsTray) showMenu() {
	menu := w.menu.Load()
	hwnd := w.hwnd.Load()
	if menu == 0 || hwnd == 0 {
		return
	}

	var cursor point
	if ok, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&cursor))); ok == 0 {
		return
	}

	_, _, _ = procSetForegroundWindow.Call(hwnd)
	command, _, _ := procTrackPopupMenu.Call(
		menu,
		tpmReturnCommand|tpmRightButton,
		uintptr(int32(cursor.X)),
		uintptr(int32(cursor.Y)),
		0,
		hwnd,
		0,
	)
	_, _, _ = procPostMessageW.Call(hwnd, wmNull, 0, 0)

	switch command {
	case menuItemShow:
		if w.onOpen != nil {
			go w.onOpen()
		}
	case menuItemExit:
		if w.onExit != nil {
			go w.onExit()
		}
	}
}

func (w *windowsTray) removeIcon() {
	hwnd := w.hwnd.Load()
	if hwnd == 0 {
		return
	}
	nid := notifyIconData{
		Size: uint32(unsafe.Sizeof(notifyIconData{})),
		HWnd: hwnd,
		ID:   trayIconID,
	}
	shellNotifyIcon(nimDelete, &nid)
	w.available.Store(false)
}

func windowsTrayProc(hwnd uintptr, msg uint32, wParam uintptr, lParam uintptr) uintptr {
	value, _ := trayManagers.Load(hwnd)
	manager, _ := value.(*windowsTray)

	switch msg {
	case trayCallbackMessage:
		if manager != nil {
			switch trayCallbackEvent(lParam) {
			case wmLButtonUp, wmLButtonDoubleClick:
				if manager.onOpen != nil {
					go manager.onOpen()
				}
			case wmRButtonUp, wmContextMenu:
				manager.showMenu()
			}
		}
		return 0
	case wmClose:
		if manager != nil {
			manager.removeIcon()
		}
		_, _, _ = procDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		trayManagers.Delete(hwnd)
		_, _, _ = procPostQuitMessage.Call(0)
		return 0
	default:
		ret, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
		return ret
	}
}

func copyUTF16(target []uint16, value string) {
	encoded := windows.StringToUTF16(value)
	if len(encoded) > len(target) {
		encoded = encoded[:len(target)]
		encoded[len(encoded)-1] = 0
	}
	copy(target, encoded)
}

func shellNotifyIcon(command uintptr, data *notifyIconData) bool {
	ret, _, _ := procShellNotifyIconW.Call(command, uintptr(unsafe.Pointer(data)))
	return ret != 0
}

func extractIcon(executable string) uintptr {
	icon, _, _ := procExtractIconW.Call(
		0,
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(executable))),
		0,
	)
	return icon
}
