package tray

func trayCallbackEvent(lParam uintptr) uint32 {
	return uint32(lParam & 0xffff)
}
