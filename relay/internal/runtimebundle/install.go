package runtimebundle

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	windowsRetryAttempts     = 8
	windowsRetryInitialDelay = 100 * time.Millisecond
	windowsRetryMaxDelay     = time.Second
)

// PrepareDir recreates a runtime directory when possible. On Windows we
// tolerate transient file locks and fall back to repairing the directory
// in-place so a previous interrupted extraction does not block startup.
func PrepareDir(rootDir string, perm os.FileMode) error {
	if err := runWithRetry(func() error {
		return os.RemoveAll(rootDir)
	}); err != nil {
		if runtime.GOOS != "windows" {
			return err
		}
	}

	return runWithRetry(func() error {
		return os.MkdirAll(rootDir, perm)
	})
}

func WriteFile(path string, data []byte, perm os.FileMode) error {
	if err := runWithRetry(func() error {
		return os.MkdirAll(filepath.Dir(path), 0755)
	}); err != nil {
		return err
	}

	var lastErr error
	for attempt := 0; attempt < retryAttempts(); attempt++ {
		if err := os.WriteFile(path, data, perm); err == nil {
			return nil
		} else {
			lastErr = err
		}

		if same, err := fileMatches(path, data); err == nil && same {
			return nil
		}

		if attempt == retryAttempts()-1 {
			break
		}
		time.Sleep(retryDelay(attempt))
	}

	return lastErr
}

func runWithRetry(operation func() error) error {
	var lastErr error
	for attempt := 0; attempt < retryAttempts(); attempt++ {
		if err := operation(); err == nil || os.IsNotExist(err) {
			return nil
		} else {
			lastErr = err
		}

		if attempt == retryAttempts()-1 {
			break
		}
		time.Sleep(retryDelay(attempt))
	}

	return lastErr
}

func retryAttempts() int {
	if runtime.GOOS == "windows" {
		return windowsRetryAttempts
	}
	return 1
}

func retryDelay(attempt int) time.Duration {
	delay := windowsRetryInitialDelay << attempt
	if delay > windowsRetryMaxDelay {
		return windowsRetryMaxDelay
	}
	return delay
}

func fileMatches(path string, expected []byte) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	return bytes.Equal(data, expected), nil
}
