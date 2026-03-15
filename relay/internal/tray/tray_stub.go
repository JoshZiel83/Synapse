//go:build !windows

package tray

type stubManager struct{}

func newManager(appName string, onOpen func(), onExit func()) (Manager, error) {
	return &stubManager{}, nil
}

func (s *stubManager) Available() bool {
	return false
}

func (s *stubManager) ShowNotification(title, message string, warning bool) error {
	return nil
}

func (s *stubManager) Close() error {
	return nil
}
