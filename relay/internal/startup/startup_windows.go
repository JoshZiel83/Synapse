//go:build windows

package startup

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows/registry"
)

const runKeyPath = `Software\Microsoft\Windows\CurrentVersion\Run`

func Sync(enabled bool, command string) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return fmt.Errorf("open startup registry key: %w", err)
	}
	defer key.Close()

	if !enabled {
		if err := key.DeleteValue(appName); err != nil && err != registry.ErrNotExist {
			return fmt.Errorf("delete startup registry value: %w", err)
		}
		return nil
	}

	if err := key.SetStringValue(appName, command); err != nil {
		return fmt.Errorf("write startup registry value: %w", err)
	}
	return nil
}

func IsEnabled() (bool, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.QUERY_VALUE)
	if err != nil {
		if err == registry.ErrNotExist {
			return false, nil
		}
		return false, fmt.Errorf("open startup registry key: %w", err)
	}
	defer key.Close()

	value, _, err := key.GetStringValue(appName)
	if err != nil {
		if err == registry.ErrNotExist {
			return false, nil
		}
		return false, fmt.Errorf("read startup registry value: %w", err)
	}

	return value != "", nil
}

func Command(launchHidden bool) (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve executable: %w", err)
	}
	command := fmt.Sprintf(`"%s"`, executable)
	if launchHidden {
		command += " " + LaunchAtLoginFlag
	}
	return command, nil
}
