//go:build darwin

package cloud

import (
	"os/exec"
	"strings"
)

func platformSystemDescription() string {
	productName := commandOutput("sw_vers", "-productName")
	productVersion := commandOutput("sw_vers", "-productVersion")

	switch {
	case productName != "" && productVersion != "":
		return productName + " " + productVersion
	case productName != "":
		return productName
	case productVersion != "":
		return "macOS " + productVersion
	default:
		return ""
	}
}

func commandOutput(name string, args ...string) string {
	output, err := exec.Command(name, args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}
