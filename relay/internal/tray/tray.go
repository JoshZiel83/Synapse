package tray

type Manager interface {
	Available() bool
	ShowNotification(title, message string, warning bool) error
	Close() error
}

func New(appName string, onOpen func(), onExit func()) (Manager, error) {
	return newManager(appName, onOpen, onExit)
}
