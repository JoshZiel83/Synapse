package cua

type overlayHotkeyAction string

const (
	overlayHotkeyTerminate   overlayHotkeyAction = "terminate"
	overlayHotkeyDisableBoot overlayHotkeyAction = "disable_boot"
)

type actionHUDState struct {
	RuntimeSessionID string
	Action           string
	Label            string
	DisplayIndex     int
	X                int
	Y                int
	ScreenX          int
	ScreenY          int
	StartX           int
	StartY           int
	EndX             int
	EndY             int
	StartScreenX     int
	StartScreenY     int
	EndScreenX       int
	EndScreenY       int
	TextLength       int
	Keys             []string
	Button           string
	ClickCount       int
	Direction        string
	Amount           float64
}

type overlayCaptureInfo struct {
	ExcludedWindowIDs []uint64
}

type overlayController interface {
	Start() error
	Close() error
	Show(runtimeSessionID string) error
	Hide(runtimeSessionID string)
	Update(state actionHUDState)
	CaptureInfo(runtimeSessionID string) overlayCaptureInfo
}

var newOverlayController = func(handler func(overlayHotkeyAction)) overlayController {
	return newStubOverlayController(handler)
}
