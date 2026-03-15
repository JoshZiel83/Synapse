//go:build linux

package startup

import (
	"fmt"
	"os"
	"path/filepath"
)

func Sync(enabled bool, command string) error {
	path, err := autostartPath()
	if err != nil {
		return err
	}

	if !enabled {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove autostart desktop entry: %w", err)
		}
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create autostart directory: %w", err)
	}

	content := fmt.Sprintf(`[Desktop Entry]
Type=Application
Version=1.0
Name=%s
Exec=%s
X-GNOME-Autostart-enabled=true
`, appName, command)

	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return fmt.Errorf("write autostart desktop entry: %w", err)
	}
	return nil
}

func IsEnabled() (bool, error) {
	path, err := autostartPath()
	if err != nil {
		return false, err
	}
	_, err = os.Stat(path)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, fmt.Errorf("stat autostart desktop entry: %w", err)
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

func autostartPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	return filepath.Join(home, ".config", "autostart", "synapse-relay.desktop"), nil
}
