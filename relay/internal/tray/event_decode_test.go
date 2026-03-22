package tray

import "testing"

func TestTrayCallbackEventDecodesNotifyIconVersion4Payload(t *testing.T) {
	const (
		iconID = 1
		event  = 0x0203
	)

	lParam := uintptr(iconID<<16 | event)
	if got := trayCallbackEvent(lParam); got != event {
		t.Fatalf("expected event %#x, got %#x", event, got)
	}
}
