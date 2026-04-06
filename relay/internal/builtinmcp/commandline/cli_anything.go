package commandline

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/commandlinebundle"
)

const commandlineProfile = "unified-bash-v1"

func (s *Server) buildMetadata() map[string]interface{} {
	metadata := map[string]interface{}{
		"commandlineProfile": commandlineProfile,
	}
	if s.installation == nil || len(s.installation.CliAnythingCapabilities) == 0 {
		metadata["cliAnythingCapabilities"] = []map[string]interface{}{}
		return metadata
	}

	capabilities := make([]map[string]interface{}, 0, len(s.installation.CliAnythingCapabilities))
	for _, capability := range s.installation.CliAnythingCapabilities {
		capabilities = append(capabilities, s.probeCliAnythingCapability(capability))
	}
	metadata["cliAnythingCapabilities"] = capabilities
	return metadata
}

func (s *Server) probeCliAnythingCapability(capability commandlinebundle.CliAnythingCapability) map[string]interface{} {
	report := map[string]interface{}{
		"slug":    capability.Slug,
		"command": capability.Command,
		"module":  capability.Module,
		"version": capability.Version,
		"ready":   false,
		"reason":  "cli-anything wrapper is unavailable",
	}

	wrapperPath := s.resolveCliAnythingWrapperPath(capability.Command)
	if wrapperPath == "" {
		return report
	}

	if ok, reason := s.checkCliAnythingWrapperCommand(wrapperPath); !ok {
		report["reason"] = reason
		return report
	}

	probe := capability.Probe
	switch strings.TrimSpace(probe.Type) {
	case "", "wrapper_only":
		report["ready"] = true
		report["reason"] = "cli-anything wrapper is ready"
		return report
	case "executable_any":
		resolved := resolveProbeExecutable(probe)
		if resolved == "" {
			report["reason"] = missingExecutableReason(probe)
			return report
		}
		report["ready"] = true
		report["reason"] = fmt.Sprintf("cli-anything wrapper is ready; found dependency %s", resolved)
		report["resolvedDependency"] = resolved
		return report
	default:
		report["ready"] = true
		report["reason"] = fmt.Sprintf("cli-anything wrapper is ready; unsupported probe type %q treated as wrapper-only", probe.Type)
		return report
	}
}

func (s *Server) resolveCliAnythingWrapperPath(command string) string {
	if s.installation == nil || strings.TrimSpace(s.installation.ManagedBinDir) == "" || strings.TrimSpace(command) == "" {
		return ""
	}
	path := filepath.Join(s.installation.ManagedBinDir, command)
	if _, err := os.Stat(path); err == nil {
		return path
	}
	return ""
}

func (s *Server) checkCliAnythingWrapperCommand(wrapperPath string) (bool, string) {
	bashBinary, err := s.resolveBashBinary()
	if err != nil {
		return false, err.Error()
	}
	if strings.TrimSpace(wrapperPath) == "" {
		return false, "cli-anything command is not configured"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	cmd := exec.CommandContext(
		ctx,
		bashBinary,
		"-lc",
		`"$1" --help >/dev/null`,
		"--",
		wrapperPath,
	)
	applyPlatformProcessAttrs(cmd)
	cmd.Env = s.environment(nil)

	output, runErr := cmd.CombinedOutput()
	if runErr != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return false, "cli-anything wrapper help check timed out"
		}
		return false, fmt.Sprintf("cli-anything wrapper check failed: %s", summarizeCommandOutput(output, runErr))
	}

	return true, ""
}

func resolveProbeExecutable(probe commandlinebundle.CliAnythingProbe) string {
	if envVar := strings.TrimSpace(probe.EnvPathVar); envVar != "" {
		if value := strings.TrimSpace(os.Getenv(envVar)); value != "" {
			if resolved := resolveExistingPath(value); resolved != "" {
				return resolved
			}
		}
	}

	for _, candidate := range probe.Candidates {
		if resolved := resolveExecutableFromPATH(candidate); resolved != "" {
			return resolved
		}
	}

	for _, candidate := range probe.Candidates {
		if resolved := resolveExecutableFromAugmentedSearchPaths(candidate); resolved != "" {
			return resolved
		}
	}

	for _, candidate := range probe.Paths {
		if resolved := resolveExistingPath(candidate); resolved != "" {
			return resolved
		}
	}

	return ""
}

func resolveExecutableFromPATH(candidate string) string {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		return ""
	}
	if path, err := exec.LookPath(candidate); err == nil {
		return path
	}
	return ""
}

func resolveExecutableFromAugmentedSearchPaths(candidate string) string {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		return ""
	}
	for _, dir := range augmentedProbeSearchPaths() {
		if resolved := resolveExistingPath(filepath.Join(dir, candidate)); resolved != "" {
			return resolved
		}
	}
	return ""
}

func augmentedProbeSearchPaths() []string {
	if runtime.GOOS != "darwin" {
		return nil
	}

	var entries []string
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		entries = append(entries,
			filepath.Join(home, "bin"),
			filepath.Join(home, ".local", "bin"),
		)
	}
	entries = append(entries,
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/opt/local/bin",
	)
	return uniqueNonEmptyStrings(entries)
}

func resolveExistingPath(candidate string) string {
	candidate = expandUserPath(strings.TrimSpace(candidate))
	if candidate == "" {
		return ""
	}
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate
	}
	return ""
}

func expandUserPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || !strings.HasPrefix(value, "~") {
		return value
	}

	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return value
	}

	switch value {
	case "~":
		return home
	case "~/":
		return home + string(os.PathSeparator)
	}

	if strings.HasPrefix(value, "~/") || strings.HasPrefix(value, "~\\") {
		return filepath.Join(home, value[2:])
	}

	return value
}

func uniqueNonEmptyStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func missingExecutableReason(probe commandlinebundle.CliAnythingProbe) string {
	parts := make([]string, 0, 3)
	if envVar := strings.TrimSpace(probe.EnvPathVar); envVar != "" {
		parts = append(parts, fmt.Sprintf("env %s", envVar))
	}
	if len(probe.Candidates) > 0 {
		parts = append(parts, fmt.Sprintf("PATH candidates [%s]", strings.Join(probe.Candidates, ", ")))
	}
	if len(probe.Paths) > 0 {
		parts = append(parts, fmt.Sprintf("known paths [%s]", strings.Join(probe.Paths, ", ")))
	}
	if len(parts) == 0 {
		return "required local dependency is missing"
	}
	return fmt.Sprintf("required local dependency is missing (%s)", strings.Join(parts, "; "))
}

func summarizeCommandOutput(output []byte, runErr error) string {
	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" {
		return runErr.Error()
	}
	if len(trimmed) > 240 {
		trimmed = trimmed[:240] + "..."
	}
	return trimmed
}
