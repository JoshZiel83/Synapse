//go:build desktop_cua

package cua

import deskact "github.com/PekingSpades/DeskAct"

type desktopCaptureOptions = deskact.CaptureOptions

const (
	desktopCaptureBackendDXGI             = deskact.CaptureBackendDXGI
	desktopCaptureBackendCGDisplay        = deskact.CaptureBackendCGDisplay
	desktopCaptureBackendScreenCaptureKit = deskact.CaptureBackendScreenCaptureKit
)

func defaultDesktopCaptureOptions() desktopCaptureOptions {
	return deskact.DefaultCaptureOptions()
}
