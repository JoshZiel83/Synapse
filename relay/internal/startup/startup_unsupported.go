//go:build !windows && !darwin && !linux

package startup

func Sync(_ bool, _ string) error {
	return nil
}

func IsEnabled() (bool, error) {
	return false, nil
}

func Command() (string, error) {
	return "", nil
}
