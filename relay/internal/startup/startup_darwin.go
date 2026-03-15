//go:build darwin

package startup

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const launchAgentName = "com.synapse.relay.gui"

func Sync(enabled bool, command string) error {
	path, err := launchAgentPath()
	if err != nil {
		return err
	}

	if !enabled {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove launch agent: %w", err)
		}
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create launch agent directory: %w", err)
	}

	content := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
%s
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`, launchAgentName, launchAgentArgumentsXML(command))

	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return fmt.Errorf("write launch agent: %w", err)
	}
	return nil
}

func IsEnabled() (bool, error) {
	path, err := launchAgentPath()
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
	return false, fmt.Errorf("stat launch agent: %w", err)
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

func launchAgentPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentName+".plist"), nil
}

func launchAgentArgumentsXML(command string) string {
	parts := []string{executableOnly(command)}
	if strings.Contains(command, LaunchAtLoginFlag) {
		parts = append(parts, LaunchAtLoginFlag)
	}

	lines := make([]string, 0, len(parts))
	for _, part := range parts {
		lines = append(lines, fmt.Sprintf("    <string>%s</string>", part))
	}
	return strings.Join(lines, "\n")
}

func executableOnly(command string) string {
	trimmed := strings.TrimSpace(command)
	if len(trimmed) >= 2 && trimmed[0] == '"' {
		if end := strings.Index(trimmed[1:], `"`); end >= 0 {
			return trimmed[1 : end+1]
		}
	}
	return strings.Fields(trimmed)[0]
}
