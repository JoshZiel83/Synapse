//go:build !desktop_cua

package cua

type desktopCaptureOptions struct {
	Backend           string
	ExcludedWindowIDs []uint64
}

const (
	desktopCaptureBackendDXGI             = "dxgi"
	desktopCaptureBackendCGDisplay        = "cgdisplay"
	desktopCaptureBackendScreenCaptureKit = "screencapturekit"
)

func defaultDesktopCaptureOptions() desktopCaptureOptions {
	return desktopCaptureOptions{}
}
