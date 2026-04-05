package cua

import deskact "github.com/PekingSpades/DeskAct"

type captureOptionsAwareDesktop interface {
	SetCaptureOptionsProvider(func() (deskact.CaptureOptions, error))
}
