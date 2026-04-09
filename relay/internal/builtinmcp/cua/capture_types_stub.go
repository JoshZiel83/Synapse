//go:build !desktop_cua

package cua

type desktopCaptureOptions struct {
	Backend           string
	ExcludedWindowIDs []uint64
}

const (
	desktopCaptureBackendDXGI             = "dxgi"
	desktopCaptureBackendGDI              = "gdi"
	desktopCaptureBackendCGDisplay        = "cgdisplay"
	desktopCaptureBackendScreenCaptureKit = "screencapturekit"
)

func defaultDesktopCaptureOptions() desktopCaptureOptions {
	return desktopCaptureOptions{}
}
