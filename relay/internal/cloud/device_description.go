package cloud

import (
	"fmt"
	"runtime"
	"strings"
)

func DefaultRelayDescription(deviceType string) string {
	return formatRelayDescription(deviceType, runtime.GOOS, platformSystemDescription())
}

func formatRelayDescription(deviceType, goos, systemDescription string) string {
	deviceLabel := humanizeDeviceType(deviceType)
	systemLabel := strings.TrimSpace(systemDescription)
	if systemLabel == "" {
		systemLabel = platformDisplayName(goos)
	}

	switch {
	case deviceLabel != "" && systemLabel != "":
		return fmt.Sprintf("%s running %s", deviceLabel, systemLabel)
	case deviceLabel != "":
		return deviceLabel
	case systemLabel != "":
		return systemLabel
	default:
		return "Device"
	}
}

func humanizeDeviceType(deviceType string) string {
	switch strings.TrimSpace(deviceType) {
	case "desktop_computer":
		return "Desktop computer"
	case "laptop_computer":
		return "Laptop computer"
	case "mobile_phone":
		return "Mobile phone"
	case "tablet":
		return "Tablet"
	case "server":
		return "Server"
	case "virtual_machine":
		return "Virtual machine"
	case "custom":
		return "Custom device"
	}

	parts := strings.Fields(strings.NewReplacer("_", " ", "-", " ").Replace(strings.TrimSpace(deviceType)))
	if len(parts) == 0 {
		return ""
	}

	for i, part := range parts {
		lower := strings.ToLower(part)
		parts[i] = strings.ToUpper(lower[:1]) + lower[1:]
	}
	return strings.Join(parts, " ")
}
