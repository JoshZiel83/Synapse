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

const commandlineProfile = "unified-bash-v2"

func (s *Server) buildMetadata() map[string]interface{} {
	metadata := map[string]interface{}{
		"commandlineProfile": commandlineProfile,
	}
	if s.installation == nil {
		metadata["managedProviders"] = []map[string]interface{}{}
		metadata["managedCapabilities"] = []map[string]interface{}{}
		return metadata
	}

	providerReadyCount := make(map[string]int, len(s.installation.ManagedProviders))
	providerTotalCount := make(map[string]int, len(s.installation.ManagedProviders))
	capabilities := make([]map[string]interface{}, 0, len(s.installation.ManagedCapabilities))
	for _, capability := range s.installation.ManagedCapabilities {
		report := s.probeManagedCapability(capability)
		capabilities = append(capabilities, report)
		providerTotalCount[capability.Provider]++
		if ready, _ := report["ready"].(bool); ready {
			providerReadyCount[capability.Provider]++
		}
	}

	providers := make([]map[string]interface{}, 0, len(s.installation.ManagedProviders))
	for _, provider := range s.installation.ManagedProviders {
		totalCount := providerTotalCount[provider.Slug]
		readyCount := providerReadyCount[provider.Slug]
		providers = append(providers, map[string]interface{}{
			"slug":        provider.Slug,
			"displayName": provider.DisplayName,
			"runtimeType": provider.RuntimeType,
			"version":     provider.Version,
			"totalCount":  totalCount,
			"readyCount":  readyCount,
			"failedCount": totalCount - readyCount,
		})
	}

	metadata["managedProviders"] = providers
	metadata["managedCapabilities"] = capabilities
	return metadata
}

func (s *Server) probeManagedCapability(capability commandlinebundle.ManagedCapability) map[string]interface{} {
	report := map[string]interface{}{
		"provider":            capability.Provider,
		"providerDisplayName": capability.ProviderDisplayName,
		"slug":                capability.Slug,
		"command":             capability.Command,
		"module":              capability.Module,
		"version":             capability.Version,
		"ready":               false,
		"reason":              "managed command wrapper is unavailable",
	}

	if strings.TrimSpace(capability.UnavailableReason) != "" {
		report["reason"] = capability.UnavailableReason
		return report
	}

	wrapperPath := s.resolveManagedCommandPath(capability.Command)
	if wrapperPath == "" {
		return report
	}

	if ok, reason := s.checkManagedCommandWrapper(wrapperPath); !ok {
		report["reason"] = reason
		return report
	}

	probe := capability.Probe
	switch strings.TrimSpace(probe.Type) {
	case "", "wrapper_only", "command_help":
		report["ready"] = true
		report["reason"] = "managed command is ready"
		return report
	case "executable_any":
		resolved := resolveProbeExecutable(probe)
		if resolved == "" {
			report["reason"] = missingExecutableReason(probe)
			return report
		}
		report["ready"] = true
		report["reason"] = fmt.Sprintf("managed command is ready; found dependency %s", resolved)
		report["resolvedDependency"] = resolved
		return report
	default:
		report["ready"] = true
		report["reason"] = fmt.Sprintf("managed command is ready; unsupported probe type %q treated as wrapper-only", probe.Type)
		return report
	}
}

func (s *Server) resolveManagedCommandPath(command string) string {
	if s.installation == nil || strings.TrimSpace(s.installation.ManagedBinDir) == "" || strings.TrimSpace(command) == "" {
		return ""
	}
	path := filepath.Join(s.installation.ManagedBinDir, command)
	if _, err := os.Stat(path); err == nil {
		return path
	}
	if runtime.GOOS == "windows" {
		exePath := path + ".exe"
		if _, err := os.Stat(exePath); err == nil {
			return exePath
		}
	}
	return ""
}

func (s *Server) checkManagedCommandWrapper(wrapperPath string) (bool, string) {
	bashBinary, err := s.resolveBashBinary()
	if err != nil {
		return false, err.Error()
	}
	if strings.TrimSpace(wrapperPath) == "" {
		return false, "managed command is not configured"
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
			return false, "managed command help check timed out"
		}
		return false, fmt.Sprintf("managed command check failed: %s", summarizeCommandOutput(output, runErr))
	}

	return true, ""
}

func resolveProbeExecutable(probe commandlinebundle.ManagedCapabilityProbe) string {
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
	case "~/", "~\\":
		return home + string(os.PathSeparator)
	}

	if strings.HasPrefix(value, "~/") || strings.HasPrefix(value, "~\\") {
		remainder := strings.TrimLeft(value[1:], "/\\")
		return filepath.Join(home, filepath.FromSlash(strings.ReplaceAll(remainder, "\\", "/")))
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

func missingExecutableReason(probe commandlinebundle.ManagedCapabilityProbe) string {
	if envVar := strings.TrimSpace(probe.EnvPathVar); envVar != "" {
		return fmt.Sprintf("managed command wrapper is ready; dependency probe failed, set %s or install one of: %s", envVar, joinProbeCandidates(probe))
	}
	return fmt.Sprintf("managed command wrapper is ready; dependency probe failed, install one of: %s", joinProbeCandidates(probe))
}

func joinProbeCandidates(probe commandlinebundle.ManagedCapabilityProbe) string {
	candidates := uniqueNonEmptyStrings(append(append([]string{}, probe.Candidates...), probe.Paths...))
	if len(candidates) == 0 {
		return "the required dependency"
	}
	return strings.Join(candidates, ", ")
}

func summarizeCommandOutput(output []byte, runErr error) string {
	text := strings.TrimSpace(string(output))
	switch {
	case text == "" && runErr != nil:
		return runErr.Error()
	case text == "":
		return "unknown failure"
	case runErr == nil:
		return text
	default:
		return fmt.Sprintf("%v; %s", runErr, text)
	}
}
