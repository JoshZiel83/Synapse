//go:build linux

package cloud

import (
	"os"
	"strings"
)

func platformSystemDescription() string {
	for _, path := range []string{"/etc/os-release", "/usr/lib/os-release"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}

		values := parseOSRelease(string(data))
		if pretty := strings.TrimSpace(values["PRETTY_NAME"]); pretty != "" {
			return pretty
		}

		name := strings.TrimSpace(values["NAME"])
		version := strings.TrimSpace(values["VERSION"])
		if name != "" && version != "" {
			return name + " " + version
		}
		version = strings.TrimSpace(values["VERSION_ID"])
		if name != "" && version != "" {
			return name + " " + version
		}
		if name != "" {
			return name
		}
	}

	return ""
}

func parseOSRelease(content string) map[string]string {
	values := make(map[string]string)
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		values[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), `"'`)
	}
	return values
}
