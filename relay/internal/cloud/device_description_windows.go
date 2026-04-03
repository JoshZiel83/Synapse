//go:build windows

package cloud

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

const windowsCurrentVersionKey = `SOFTWARE\Microsoft\Windows NT\CurrentVersion`

func platformSystemDescription() string {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, windowsCurrentVersionKey, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer key.Close()

	productName, _, _ := key.GetStringValue("ProductName")
	displayVersion, _, _ := key.GetStringValue("DisplayVersion")
	if strings.TrimSpace(displayVersion) == "" {
		displayVersion, _, _ = key.GetStringValue("ReleaseId")
	}

	productName = strings.TrimSpace(productName)
	displayVersion = strings.TrimSpace(displayVersion)

	switch {
	case productName != "" && displayVersion != "":
		return productName + " " + displayVersion
	case productName != "":
		return productName
	case displayVersion != "":
		return "Windows " + displayVersion
	default:
		return ""
	}
}
