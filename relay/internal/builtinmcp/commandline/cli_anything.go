package commandline

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/commandlinebundle"
)

const commandlineProfile = "unified-bash-v2"

type managedCapabilityProbeResult struct {
	ready   bool
	reason  string
	details map[string]interface{}
}

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

	probeResult := s.evaluateManagedCapabilityProbe(capability.Probe)
	if !probeResult.ready {
		report["reason"] = probeResult.reason
		return report
	}
	report["ready"] = true
	report["reason"] = probeResult.reason
	for key, value := range probeResult.details {
		report[key] = value
	}
	return report
}

func (s *Server) evaluateManagedCapabilityProbe(probe commandlinebundle.ManagedCapabilityProbe) managedCapabilityProbeResult {
	switch strings.TrimSpace(probe.Type) {
	case "", "wrapper_only", "command_help":
		return managedCapabilityProbeResult{
			ready:  true,
			reason: "managed command is ready",
		}
	case "executable_any":
		resolved := resolveProbeExecutable(probe)
		if resolved == "" {
			return managedCapabilityProbeResult{
				reason: missingExecutableReason(probe),
			}
		}
		return managedCapabilityProbeResult{
			ready:  true,
			reason: fmt.Sprintf("managed command is ready; found dependency %s", resolved),
			details: map[string]interface{}{
				"resolvedDependency": resolved,
			},
		}
	case "path_any":
		resolved := resolveProbePath(probe)
		if resolved == "" {
			return managedCapabilityProbeResult{
				reason: missingPathReason(probe),
			}
		}
		return managedCapabilityProbeResult{
			ready:  true,
			reason: fmt.Sprintf("managed command is ready; found local path %s", resolved),
			details: map[string]interface{}{
				"resolvedPath": resolved,
			},
		}
	case "env_any":
		resolvedVar, resolvedValue := resolveProbeEnvironmentVariable(probe)
		if resolvedVar == "" {
			return managedCapabilityProbeResult{
				reason: missingEnvironmentVariableReason(probe),
			}
		}
		return managedCapabilityProbeResult{
			ready:  true,
			reason: fmt.Sprintf("managed command is ready; found environment variable %s", resolvedVar),
			details: map[string]interface{}{
				"resolvedEnvVar":   resolvedVar,
				"resolvedEnvValue": resolvedValue,
			},
		}
	case "python_import_any":
		moduleName, searchPaths, ok, reason := s.probeManagedCapabilityPythonImport(probe)
		if !ok {
			return managedCapabilityProbeResult{
				reason: reason,
			}
		}
		details := map[string]interface{}{
			"resolvedPythonModule": moduleName,
		}
		if len(searchPaths) > 0 {
			details["resolvedPythonPaths"] = searchPaths
		}
		return managedCapabilityProbeResult{
			ready:   true,
			reason:  fmt.Sprintf("managed command is ready; imported Python module %s", moduleName),
			details: details,
		}
	case "http_any":
		resolvedURL, statusCode, ok, reason := probeManagedCapabilityHTTP(probe)
		if !ok {
			return managedCapabilityProbeResult{
				reason: reason,
			}
		}
		return managedCapabilityProbeResult{
			ready:  true,
			reason: fmt.Sprintf("managed command is ready; reached local dependency %s (HTTP %d)", resolvedURL, statusCode),
			details: map[string]interface{}{
				"resolvedURL": resolvedURL,
				"httpStatus":  statusCode,
			},
		}
	case "any_of":
		if len(probe.AnyOf) == 0 {
			return managedCapabilityProbeResult{
				reason: "managed command wrapper is ready; dependency probe failed, any_of was configured without child probes",
			}
		}
		failures := make([]string, 0, len(probe.AnyOf))
		for _, child := range probe.AnyOf {
			result := s.evaluateManagedCapabilityProbe(child)
			if result.ready {
				return result
			}
			failures = append(failures, result.reason)
		}
		return managedCapabilityProbeResult{
			reason: fmt.Sprintf("managed command wrapper is ready; dependency probe failed, no readiness condition passed (%s)", strings.Join(failures, "; ")),
		}
	case "all_of":
		if len(probe.AllOf) == 0 {
			return managedCapabilityProbeResult{
				reason: "managed command wrapper is ready; dependency probe failed, all_of was configured without child probes",
			}
		}
		details := map[string]interface{}{}
		reasons := make([]string, 0, len(probe.AllOf))
		for _, child := range probe.AllOf {
			result := s.evaluateManagedCapabilityProbe(child)
			if !result.ready {
				return result
			}
			reasons = append(reasons, result.reason)
			for key, value := range result.details {
				details[key] = value
			}
		}
		return managedCapabilityProbeResult{
			ready:   true,
			reason:  strings.Join(reasons, "; "),
			details: details,
		}
	default:
		return managedCapabilityProbeResult{
			ready:  true,
			reason: fmt.Sprintf("managed command is ready; unsupported probe type %q treated as wrapper-only", probe.Type),
		}
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

func resolveProbePath(probe commandlinebundle.ManagedCapabilityProbe) string {
	if envVar := strings.TrimSpace(probe.EnvPathVar); envVar != "" {
		if resolved := resolveExistingPathOrDir(os.Getenv(envVar)); resolved != "" {
			return resolved
		}
	}

	for _, candidate := range probe.Paths {
		if resolved := resolveExistingPathOrDir(candidate); resolved != "" {
			return resolved
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

func resolveProbeEnvironmentVariable(probe commandlinebundle.ManagedCapabilityProbe) (string, string) {
	for _, envVar := range uniqueNonEmptyStrings(probe.EnvVars) {
		if value := strings.TrimSpace(os.Getenv(envVar)); value != "" {
			return envVar, value
		}
	}
	return "", ""
}

func probeManagedCapabilityHTTP(probe commandlinebundle.ManagedCapabilityProbe) (string, int, bool, string) {
	urls := uniqueNonEmptyStrings(probe.URLs)
	if len(urls) == 0 {
		return "", 0, false, "managed command wrapper is ready; dependency probe failed, no local endpoints were configured"
	}

	client := &http.Client{Timeout: 3 * time.Second}
	failures := make([]string, 0, len(urls))
	for _, endpoint := range urls {
		request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, endpoint, nil)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: invalid URL", endpoint))
			continue
		}

		response, err := client.Do(request)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", endpoint, err))
			continue
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2048))
		response.Body.Close()

		if httpStatusAllowed(response.StatusCode, probe.SuccessStatuses) {
			return endpoint, response.StatusCode, true, ""
		}
		failures = append(failures, fmt.Sprintf("%s: HTTP %d", endpoint, response.StatusCode))
	}

	return "", 0, false, fmt.Sprintf(
		"managed command wrapper is ready; dependency probe failed, ensure one of these local endpoints is reachable: %s",
		strings.Join(failures, "; "),
	)
}

func httpStatusAllowed(statusCode int, allowed []int) bool {
	if len(allowed) != 0 {
		for _, candidate := range allowed {
			if statusCode == candidate {
				return true
			}
		}
		return false
	}
	return statusCode >= 200 && statusCode < 400
}

func (s *Server) probeManagedCapabilityPythonImport(probe commandlinebundle.ManagedCapabilityProbe) (string, []string, bool, string) {
	pythonBinary, err := s.resolvePythonBinary()
	if err != nil {
		return "", nil, false, fmt.Sprintf("managed command wrapper is ready; Python import probe failed: %s", err.Error())
	}

	moduleNames := uniqueNonEmptyStrings(probe.Candidates)
	if len(moduleNames) == 0 {
		return "", nil, false, "managed command wrapper is ready; Python import probe failed, no module names were configured"
	}

	searchPaths := make([]string, 0, len(probe.Paths))
	for _, candidate := range probe.Paths {
		if resolved := resolveExistingPathOrDir(candidate); resolved != "" {
			searchPaths = append(searchPaths, resolved)
		}
	}
	searchPaths = uniqueNonEmptyStrings(searchPaths)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	for _, moduleName := range moduleNames {
		cmd := exec.CommandContext(
			ctx,
			pythonBinary,
			"-c",
			"import importlib, sys; importlib.import_module(sys.argv[1])",
			moduleName,
		)
		cmd.Env = s.environment(nil)
		if len(searchPaths) > 0 {
			cmd.Env = overrideEnvVar(cmd.Env, "PYTHONPATH", prependPathEntries(currentEnvValue(cmd.Env, "PYTHONPATH"), searchPaths...))
		}

		output, runErr := cmd.CombinedOutput()
		if runErr == nil {
			return moduleName, searchPaths, true, ""
		}
		if ctx.Err() == context.DeadlineExceeded {
			return "", nil, false, "managed command wrapper is ready; Python import probe timed out"
		}
		_ = output
	}

	pathHint := "default Python search path"
	if len(searchPaths) > 0 {
		pathHint = strings.Join(searchPaths, ", ")
	}
	return "", nil, false, fmt.Sprintf(
		"managed command wrapper is ready; Python import probe failed, could not import any of: %s (searched %s)",
		strings.Join(moduleNames, ", "),
		pathHint,
	)
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
	candidate = expandConfiguredPath(candidate)
	if candidate == "" {
		return ""
	}
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate
	}
	return ""
}

func resolveExistingPathOrDir(candidate string) string {
	candidate = expandConfiguredPath(candidate)
	if candidate == "" {
		return ""
	}
	if _, err := os.Stat(candidate); err == nil {
		return candidate
	}
	return ""
}

var windowsEnvPattern = regexp.MustCompile(`%([A-Za-z0-9_]+)%`)

func expandConfiguredPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	value = windowsEnvPattern.ReplaceAllStringFunc(value, func(match string) string {
		name := strings.Trim(match, "%")
		if resolved := os.Getenv(name); strings.TrimSpace(resolved) != "" {
			return resolved
		}
		return match
	})
	return expandUserPath(os.ExpandEnv(value))
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

func missingEnvironmentVariableReason(probe commandlinebundle.ManagedCapabilityProbe) string {
	envVars := uniqueNonEmptyStrings(probe.EnvVars)
	if len(envVars) == 0 {
		return "managed command wrapper is ready; dependency probe failed, set the required environment variable"
	}
	return fmt.Sprintf("managed command wrapper is ready; dependency probe failed, set one of: %s", strings.Join(envVars, ", "))
}

func missingPathReason(probe commandlinebundle.ManagedCapabilityProbe) string {
	if envVar := strings.TrimSpace(probe.EnvPathVar); envVar != "" {
		return fmt.Sprintf("managed command wrapper is ready; dependency probe failed, set %s or create one of: %s", envVar, joinProbeCandidates(probe))
	}
	return fmt.Sprintf("managed command wrapper is ready; dependency probe failed, expected one of these local paths: %s", joinProbeCandidates(probe))
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

func currentEnvValue(env []string, key string) string {
	prefix := key + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix)
		}
	}
	return ""
}

func overrideEnvVar(env []string, key, value string) []string {
	prefix := key + "="
	result := make([]string, 0, len(env)+1)
	replaced := false
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			if !replaced {
				result = append(result, prefix+value)
				replaced = true
			}
			continue
		}
		result = append(result, entry)
	}
	if !replaced {
		result = append(result, prefix+value)
	}
	return result
}

func prependPathEntries(current string, entries ...string) string {
	all := make([]string, 0, len(entries)+1)
	seen := map[string]struct{}{}
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if _, ok := seen[entry]; ok {
			continue
		}
		seen[entry] = struct{}{}
		all = append(all, entry)
	}
	if strings.TrimSpace(current) != "" {
		for _, entry := range strings.Split(current, string(os.PathListSeparator)) {
			entry = strings.TrimSpace(entry)
			if entry == "" {
				continue
			}
			if _, ok := seen[entry]; ok {
				continue
			}
			seen[entry] = struct{}{}
			all = append(all, entry)
		}
	}
	return strings.Join(all, string(os.PathListSeparator))
}
