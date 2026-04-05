package cua

type captureOptionsAwareDesktop interface {
	SetCaptureOptionsProvider(func() (desktopCaptureOptions, error))
}
