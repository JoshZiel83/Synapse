package cloud

import (
	"fmt"
	"path"
	"strings"
)

const darwinUpdateWaitSeconds = 120

func buildDarwinUpdateLauncherScript(installerPath string, executablePath string, autoLaunch bool) string {
	appBundlePath := resolveDarwinAppBundlePath(executablePath)
	autoLaunchValue := "0"
	if autoLaunch {
		autoLaunchValue = "1"
	}

	return strings.Join([]string{
		"#!/bin/bash",
		"set -euo pipefail",
		fmt.Sprintf("installer_path=%s", shellQuote(trimmedOrEmpty(installerPath))),
		fmt.Sprintf("current_executable=%s", shellQuote(trimmedOrEmpty(executablePath))),
		fmt.Sprintf("app_bundle_path=%s", shellQuote(appBundlePath)),
		fmt.Sprintf("auto_launch=%s", shellQuote(autoLaunchValue)),
		"cleanup() { rm -f \"$0\"; }",
		"trap cleanup EXIT",
		"attempt=0",
		"while [ -n \"$current_executable\" ] && pgrep -f \"$current_executable\" >/dev/null 2>&1; do",
		"  attempt=$((attempt + 1))",
		fmt.Sprintf("  if [ \"$attempt\" -ge %d ]; then", darwinUpdateWaitSeconds),
		"    exit 32",
		"  fi",
		"  sleep 1",
		"done",
		"open -W -n \"$installer_path\"",
		"if [ \"$auto_launch\" = \"1\" ] && [ -n \"$app_bundle_path\" ] && [ -d \"$app_bundle_path\" ]; then",
		"  open \"$app_bundle_path\"",
		"fi",
		"",
	}, "\n")
}

func resolveDarwinAppBundlePath(executablePath string) string {
	cleaned := trimmedOrEmpty(executablePath)
	if cleaned == "" {
		return ""
	}

	cleaned = path.Clean(cleaned)
	if cleaned == "." || cleaned == "/" {
		return ""
	}

	macOSDir := path.Dir(cleaned)
	if path.Base(macOSDir) != "MacOS" {
		return ""
	}
	contentsDir := path.Dir(macOSDir)
	if path.Base(contentsDir) != "Contents" {
		return ""
	}
	appDir := path.Dir(contentsDir)
	if !strings.HasSuffix(strings.ToLower(path.Base(appDir)), ".app") {
		return ""
	}
	return appDir
}

func trimmedOrEmpty(value string) string {
	return strings.TrimSpace(value)
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}
