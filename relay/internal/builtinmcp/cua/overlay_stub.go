//go:build !desktop_cua || (!windows && !darwin) || (darwin && !cgo)

package cua

type stubOverlayController struct{}

func newStubOverlayController(func(overlayHotkeyAction)) overlayController {
	return &stubOverlayController{}
}

func (s *stubOverlayController) Start() error          { return nil }
func (s *stubOverlayController) Close() error          { return nil }
func (s *stubOverlayController) Show(string) error     { return nil }
func (s *stubOverlayController) Hide(string)           {}
func (s *stubOverlayController) Update(actionHUDState) {}
func (s *stubOverlayController) CaptureInfo(string) overlayCaptureInfo {
	return overlayCaptureInfo{}
}
