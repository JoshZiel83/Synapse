package filesystem

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const defaultRipgrepTimeout = 20 * time.Second

var errRipgrepUnavailable = errors.New("ripgrep is not available")

func resolveRipgrepBinary() (string, error) {
	path, err := exec.LookPath("rg")
	if err != nil {
		return "", errRipgrepUnavailable
	}
	return path, nil
}

func ripgrepCommonArgs(exclude []string, respectGitignore bool) []string {
	args := []string{"--hidden", "--no-messages"}
	if respectGitignore {
		args = append(args, "--no-require-git")
	} else {
		args = append(args, "--no-ignore")
	}

	defaultNoisy := make([]string, 0, len(defaultNoisyPathSegments))
	for segment := range defaultNoisyPathSegments {
		defaultNoisy = append(defaultNoisy, segment)
	}
	sort.Strings(defaultNoisy)
	for _, pattern := range defaultNoisy {
		args = append(args, "--glob", "!"+pattern)
	}

	for _, pattern := range normalizeExcludePatterns(exclude) {
		if filepath.IsAbs(pattern) {
			continue
		}
		args = append(args, "--glob", "!"+filepath.ToSlash(pattern))
	}
	return args
}

func runRipgrepLines(ctx context.Context, workingDir, target string, args ...string) ([]string, error) {
	binaryPath, err := resolveRipgrepBinary()
	if err != nil {
		return nil, err
	}

	if ctx == nil {
		ctx = context.Background()
	}
	rgCtx, cancel := context.WithTimeout(ctx, defaultRipgrepTimeout)
	defer cancel()

	commandArgs := append(append([]string{}, args...), target)
	cmd := exec.CommandContext(rgCtx, binaryPath, commandArgs...)
	if strings.TrimSpace(workingDir) != "" {
		cmd.Dir = workingDir
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		displayTarget := target
		if displayTarget == "." && strings.TrimSpace(workingDir) != "" {
			displayTarget = workingDir
		} else if strings.TrimSpace(workingDir) != "" && !filepath.IsAbs(displayTarget) {
			displayTarget = filepath.Clean(filepath.Join(workingDir, displayTarget))
		}
		if rgCtx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("ripgrep timed out after %s while searching %q", defaultRipgrepTimeout, displayTarget)
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return nil, nil
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("ripgrep search failed for %q: %s", displayTarget, message)
	}

	return splitRipgrepLines(stdout.String()), nil
}

func splitRipgrepLines(output string) []string {
	output = strings.TrimSpace(output)
	if output == "" {
		return nil
	}
	rawLines := strings.Split(output, "\n")
	lines := make([]string, 0, len(rawLines))
	for _, line := range rawLines {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}
