//go:build darwin && desktop_cua && cgo

package cua

/*
#include <stdint.h>

enum {
    SynapseDarwinHotkeyTerminate = 1,
    SynapseDarwinHotkeyDisable = 2,
};
*/
import "C"

//export synapseDarwinOverlayHotkeyCallback
func synapseDarwinOverlayHotkeyCallback(controllerID C.uintptr_t, action C.int) {
	raw, ok := darwinOverlayControllers.Load(uint64(controllerID))
	if !ok {
		return
	}
	controller, ok := raw.(*darwinOverlayController)
	if !ok || controller == nil || controller.hotkeyHandler == nil {
		return
	}

	switch int(action) {
	case int(C.SynapseDarwinHotkeyTerminate):
		go controller.hotkeyHandler(overlayHotkeyTerminate)
	case int(C.SynapseDarwinHotkeyDisable):
		go controller.hotkeyHandler(overlayHotkeyDisableBoot)
	}
}
