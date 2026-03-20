package commandline

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/commandlinebundle"
)

type Server struct {
	cfg          Config
	installation *commandlinebundle.Installation
	tools        []core.Tool
}

func New(cfg Config) (*Server, error) {
	return &Server{cfg: cfg}, nil
}

func (s *Server) Start(ctx context.Context) error {
	installation, err := commandlinebundle.EnsureInstalled()
	if err != nil {
		return err
	}

	s.installation = installation
	s.tools = s.buildTools()
	return nil
}

func (s *Server) Initialize() error {
	return nil
}

func (s *Server) ListTools() ([]core.Tool, error) {
	tools := make([]core.Tool, len(s.tools))
	copy(tools, s.tools)
	return tools, nil
}

func (s *Server) CallTool(ctx context.Context, toolName string, args map[string]interface{}) (core.CallResult, error) {
	switch toolName {
	case "bash_exec":
		return s.callBash(ctx, args), nil
	case "git_exec":
		return s.callGit(ctx, args), nil
	case "node_exec":
		return s.callNode(ctx, args), nil
	case "python_exec":
		return s.callPython(ctx, args), nil
	default:
		return errorResult(fmt.Sprintf("unknown tool: %s", toolName)), nil
	}
}

func (s *Server) Shutdown() {}

func (s *Server) callBash(ctx context.Context, args map[string]interface{}) core.CallResult {
	binaryPath, err := s.resolveBashBinary()
	if err != nil {
		return errorResult(err.Error())
	}

	command, err := stringArg(args, "command", true)
	if err != nil {
		return errorResult(err.Error())
	}

	cwd, err := s.resolveWorkingDir(args)
	if err != nil {
		return errorResult(err.Error())
	}
	timeout, err := durationArg(args, "timeout_sec")
	if err != nil {
		return errorResult(err.Error())
	}
	env, err := mapArg(args, "env")
	if err != nil {
		return errorResult(err.Error())
	}

	return s.runCommand(ctx, "bash", binaryPath, []string{"-lc", command}, cwd, env, timeout)
}

func (s *Server) callGit(ctx context.Context, args map[string]interface{}) core.CallResult {
	binaryPath, err := s.resolveGitBinary()
	if err != nil {
		return errorResult(err.Error())
	}

	commandArgs, err := stringArrayArg(args, "args", true)
	if err != nil {
		return errorResult(err.Error())
	}

	cwd, err := s.resolveWorkingDir(args)
	if err != nil {
		return errorResult(err.Error())
	}
	timeout, err := durationArg(args, "timeout_sec")
	if err != nil {
		return errorResult(err.Error())
	}
	env, err := mapArg(args, "env")
	if err != nil {
		return errorResult(err.Error())
	}

	return s.runCommand(ctx, "git", binaryPath, commandArgs, cwd, env, timeout)
}

func (s *Server) callNode(ctx context.Context, args map[string]interface{}) core.CallResult {
	binaryPath, err := s.resolveNodeBinary()
	if err != nil {
		return errorResult(err.Error())
	}

	code, err := stringArg(args, "code", true)
	if err != nil {
		return errorResult(err.Error())
	}

	cwd, err := s.resolveWorkingDir(args)
	if err != nil {
		return errorResult(err.Error())
	}
	timeout, err := durationArg(args, "timeout_sec")
	if err != nil {
		return errorResult(err.Error())
	}
	env, err := mapArg(args, "env")
	if err != nil {
		return errorResult(err.Error())
	}

	return s.runCommand(ctx, "node", binaryPath, []string{"-e", code}, cwd, env, timeout)
}

func (s *Server) callPython(ctx context.Context, args map[string]interface{}) core.CallResult {
	binaryPath, err := s.resolvePythonBinary()
	if err != nil {
		return errorResult(err.Error())
	}

	code, err := stringArg(args, "code", true)
	if err != nil {
		return errorResult(err.Error())
	}

	cwd, err := s.resolveWorkingDir(args)
	if err != nil {
		return errorResult(err.Error())
	}
	timeout, err := durationArg(args, "timeout_sec")
	if err != nil {
		return errorResult(err.Error())
	}
	env, err := mapArg(args, "env")
	if err != nil {
		return errorResult(err.Error())
	}

	return s.runCommand(ctx, "python", binaryPath, []string{"-c", code}, cwd, env, timeout)
}

func (s *Server) runCommand(parent context.Context, runtimeName, binaryPath string, args []string, cwd string, extraEnv map[string]string, timeout time.Duration) core.CallResult {
	ctx := parent
	cancel := func() {}
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(parent, timeout)
	}
	defer cancel()

	cmd := exec.CommandContext(ctx, binaryPath, args...)
	applyPlatformProcessAttrs(cmd)
	cmd.Dir = cwd
	cmd.Env = s.environment(extraEnv)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	exitCode := 0
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else if ctx.Err() != nil {
			exitCode = -1
		} else {
			exitCode = -1
		}
	}

	stdoutText := normalizeOutput(stdout.String())
	stderrText := normalizeOutput(stderr.String())

	statusText := fmt.Sprintf("%s exited with code %d.", runtimeName, exitCode)
	if ctx.Err() == context.DeadlineExceeded {
		statusText = fmt.Sprintf("%s timed out after %s.", runtimeName, timeout)
	} else if ctx.Err() == context.Canceled {
		statusText = fmt.Sprintf("%s was canceled.", runtimeName)
	} else if runErr != nil && exitCode < 0 {
		statusText = fmt.Sprintf("%s failed to start: %v", runtimeName, runErr)
	}

	var details []string
	details = append(details, statusText)
	if stdoutText != "" {
		details = append(details, "stdout:\n"+stdoutText)
	}
	if stderrText != "" {
		details = append(details, "stderr:\n"+stderrText)
	}

	structured := map[string]interface{}{
		"runtime":      runtimeName,
		"command":      append([]string{binaryPath}, args...),
		"cwd":          cwd,
		"exitCode":     exitCode,
		"stdout":       stdoutText,
		"stderr":       stderrText,
		"timedOut":     ctx.Err() == context.DeadlineExceeded,
		"canceled":     ctx.Err() == context.Canceled,
		"assetVersion": "",
	}
	if s.installation != nil {
		structured["assetVersion"] = s.installation.AssetVersion
		structured["packageProfile"] = s.installation.PackageProfile
		structured["ffmpegReleaseTag"] = s.installation.FFmpegReleaseTag
	}
	if runErr != nil {
		structured["error"] = runErr.Error()
	}

	return core.CallResult{
		Content: []interface{}{
			core.Text(strings.Join(details, "\n\n")),
		},
		StructuredContent: structured,
		IsError:           runErr != nil,
	}
}

func (s *Server) environment(extraEnv map[string]string) []string {
	env := environmentMap(os.Environ())
	if s.installation != nil {
		if strings.TrimSpace(s.installation.NodeModulesDir) != "" {
			env["NODE_PATH"] = appendPathList(env["NODE_PATH"], s.installation.NodeModulesDir)
		}
		if strings.TrimSpace(s.installation.PythonHomeDir) != "" {
			env["PYTHONHOME"] = s.installation.PythonHomeDir
		}
		if strings.TrimSpace(s.installation.PythonSitePackagesDir) != "" {
			env["PYTHONPATH"] = appendPathList(env["PYTHONPATH"], s.installation.PythonSitePackagesDir)
		}
		env["PYTHONUTF8"] = "1"

		pathEntries := []string{}
		if strings.TrimSpace(s.installation.GitBinaryPath) != "" {
			pathEntries = append(pathEntries, filepath.Dir(s.installation.GitBinaryPath))
		}
		if strings.TrimSpace(s.installation.BashBinaryPath) != "" {
			pathEntries = append(pathEntries, filepath.Dir(s.installation.BashBinaryPath))
		}
		if strings.TrimSpace(s.installation.FFmpegBinaryPath) != "" {
			pathEntries = append(pathEntries, filepath.Dir(s.installation.FFmpegBinaryPath))
		}
		if strings.TrimSpace(s.installation.FFprobeBinaryPath) != "" {
			pathEntries = append(pathEntries, filepath.Dir(s.installation.FFprobeBinaryPath))
		}
		if len(pathEntries) > 0 {
			env["PATH"] = appendPathEntries(env["PATH"], pathEntries...)
		}
	}

	for key, value := range extraEnv {
		env[key] = value
	}
	return environmentList(env)
}

func (s *Server) resolveWorkingDir(args map[string]interface{}) (string, error) {
	if value, ok := args["cwd"]; ok {
		text := strings.TrimSpace(fmt.Sprint(value))
		if text != "" {
			info, err := os.Stat(text)
			if err != nil {
				return "", fmt.Errorf("cwd %q is not accessible: %v", text, err)
			}
			if !info.IsDir() {
				return "", fmt.Errorf("cwd %q is not a directory", text)
			}
			return text, nil
		}
	}

	if strings.TrimSpace(s.cfg.DefaultCWD) != "" {
		return s.cfg.DefaultCWD, nil
	}

	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("resolve current working directory: %w", err)
	}
	return cwd, nil
}

func (s *Server) resolveBashBinary() (string, error) {
	if s.installation != nil && strings.TrimSpace(s.installation.BashBinaryPath) != "" {
		return s.installation.BashBinaryPath, nil
	}
	path, err := exec.LookPath("bash")
	if err != nil {
		return "", fmt.Errorf("bash is not available on this system")
	}
	return path, nil
}

func (s *Server) resolveGitBinary() (string, error) {
	if s.installation != nil && strings.TrimSpace(s.installation.GitBinaryPath) != "" {
		return s.installation.GitBinaryPath, nil
	}
	path, err := exec.LookPath("git")
	if err != nil {
		return "", fmt.Errorf("git is not available on this system")
	}
	return path, nil
}

func (s *Server) resolveNodeBinary() (string, error) {
	if s.installation != nil && strings.TrimSpace(s.installation.NodeBinaryPath) != "" {
		return s.installation.NodeBinaryPath, nil
	}
	path, err := exec.LookPath("node")
	if err != nil {
		return "", fmt.Errorf("node is not available on this system")
	}
	return path, nil
}

func (s *Server) resolvePythonBinary() (string, error) {
	if s.installation != nil && strings.TrimSpace(s.installation.PythonBinaryPath) != "" {
		return s.installation.PythonBinaryPath, nil
	}

	candidates := []string{"python3", "python"}
	if runtime.GOOS == "windows" {
		candidates = []string{"python", "python3"}
	}
	for _, candidate := range candidates {
		if path, err := exec.LookPath(candidate); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("python is not available on this system")
}

func stringArg(args map[string]interface{}, key string, required bool) (string, error) {
	value, ok := args[key]
	if !ok || value == nil {
		if required {
			return "", fmt.Errorf("%s is required", key)
		}
		return "", nil
	}

	text := strings.TrimSpace(fmt.Sprint(value))
	if required && text == "" {
		return "", fmt.Errorf("%s is required", key)
	}
	return text, nil
}

func stringArrayArg(args map[string]interface{}, key string, required bool) ([]string, error) {
	value, ok := args[key]
	if !ok || value == nil {
		if required {
			return nil, fmt.Errorf("%s is required", key)
		}
		return nil, nil
	}

	raw, ok := value.([]interface{})
	if !ok {
		return nil, fmt.Errorf("%s must be an array of strings", key)
	}
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		result = append(result, fmt.Sprint(item))
	}
	if required && len(result) == 0 {
		return nil, fmt.Errorf("%s is required", key)
	}
	return result, nil
}

func mapArg(args map[string]interface{}, key string) (map[string]string, error) {
	value, ok := args[key]
	if !ok || value == nil {
		return map[string]string{}, nil
	}

	raw, ok := value.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("%s must be an object", key)
	}

	result := make(map[string]string, len(raw))
	for envKey, envValue := range raw {
		result[envKey] = fmt.Sprint(envValue)
	}
	return result, nil
}

func durationArg(args map[string]interface{}, key string) (time.Duration, error) {
	value, ok := args[key]
	if !ok || value == nil {
		return 0, nil
	}

	switch typed := value.(type) {
	case int:
		if typed <= 0 {
			return 0, fmt.Errorf("%s must be greater than 0", key)
		}
		return time.Duration(typed) * time.Second, nil
	case int64:
		if typed <= 0 {
			return 0, fmt.Errorf("%s must be greater than 0", key)
		}
		return time.Duration(typed) * time.Second, nil
	case float64:
		if typed <= 0 {
			return 0, fmt.Errorf("%s must be greater than 0", key)
		}
		return time.Duration(typed * float64(time.Second)), nil
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err != nil || parsed <= 0 {
			return 0, fmt.Errorf("%s must be a positive integer", key)
		}
		return time.Duration(parsed) * time.Second, nil
	default:
		return 0, fmt.Errorf("%s must be a number", key)
	}
}

func environmentMap(values []string) map[string]string {
	result := make(map[string]string, len(values))
	for _, entry := range values {
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) != 2 {
			continue
		}
		result[parts[0]] = parts[1]
	}
	return result
}

func environmentList(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+values[key])
	}
	return result
}

func appendPathEntries(current string, entries ...string) string {
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

func appendPathList(current, entry string) string {
	entry = strings.TrimSpace(entry)
	if entry == "" {
		return current
	}
	if strings.TrimSpace(current) == "" {
		return entry
	}
	return entry + string(os.PathListSeparator) + current
}

func normalizeOutput(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	return strings.TrimSpace(value)
}

func errorResult(message string) core.CallResult {
	return core.CallResult{
		Content: []interface{}{
			core.Text(message),
		},
		StructuredContent: map[string]interface{}{
			"message": message,
		},
		IsError: true,
	}
}
