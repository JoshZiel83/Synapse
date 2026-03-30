package runtimebundle

import (
	"bytes"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

const (
	windowsRetryAttempts     = 8
	windowsRetryInitialDelay = 100 * time.Millisecond
	windowsRetryMaxDelay     = time.Second

	installLockStaleAfter = 2 * time.Hour
)

type PendingError struct {
	RootDir string
	Reason  string
}

func (e *PendingError) Error() string {
	if e == nil {
		return "runtime bundle preparation pending"
	}
	if e.Reason == "" {
		return fmt.Sprintf("runtime bundle %s is preparing", e.RootDir)
	}
	return fmt.Sprintf("runtime bundle %s is preparing: %s", e.RootDir, e.Reason)
}

func (e *PendingError) Temporary() bool {
	return true
}

type InstallOptions struct {
	RootDir string
	Verify  func(rootDir string) bool
	Install func(stageDir string) error
}

type installState struct {
	mu         sync.Mutex
	installing bool
	lastErr    error
}

var installStates sync.Map

func Ensure(options InstallOptions) error {
	if err := options.validate(); err != nil {
		return err
	}
	if options.Verify(options.RootDir) {
		return nil
	}

	state := loadInstallState(options.RootDir)

	state.mu.Lock()
	if state.installing {
		reason := "background extraction is still running"
		if state.lastErr != nil {
			reason = fmt.Sprintf("background retry is running after: %v", state.lastErr)
		}
		state.mu.Unlock()
		return &PendingError{RootDir: options.RootDir, Reason: reason}
	}

	reason := "background extraction started"
	if state.lastErr != nil {
		reason = fmt.Sprintf("retrying after: %v", state.lastErr)
	}
	state.installing = true
	state.mu.Unlock()

	go runInstall(state, options)

	return &PendingError{RootDir: options.RootDir, Reason: reason}
}

func IsPending(err error) bool {
	var pending *PendingError
	return errors.As(err, &pending)
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

func runInstall(state *installState, options InstallOptions) {
	err := installAtomically(options)

	state.mu.Lock()
	state.installing = false
	state.lastErr = err
	state.mu.Unlock()

	if err == nil {
		installStates.Delete(options.RootDir)
	}
}

func installAtomically(options InstallOptions) error {
	if options.Verify(options.RootDir) {
		return nil
	}

	releaseLock, err := acquireInstallLock(options.RootDir)
	if err != nil {
		return err
	}
	defer releaseLock()

	if options.Verify(options.RootDir) {
		return nil
	}

	stageDir, cleanupStage, err := createStageDir(options.RootDir)
	if err != nil {
		return err
	}
	defer cleanupStage()

	if err := options.Install(stageDir); err != nil {
		return err
	}
	if !options.Verify(stageDir) {
		return fmt.Errorf("staged runtime did not pass verification")
	}

	if err := replaceDir(options.RootDir, stageDir); err != nil {
		return err
	}

	return nil
}

func acquireInstallLock(rootDir string) (func(), error) {
	lockDir := rootDir + ".lock"
	if err := runWithRetry(func() error {
		return os.MkdirAll(filepath.Dir(lockDir), 0755)
	}); err != nil {
		return nil, err
	}

	if err := os.Mkdir(lockDir, 0755); err != nil {
		if !os.IsExist(err) {
			return nil, err
		}
		stale, staleErr := lockDirIsStale(lockDir)
		if staleErr != nil {
			return nil, staleErr
		}
		if !stale {
			return nil, fmt.Errorf("runtime installation is already locked by another process")
		}
		if err := runWithRetry(func() error {
			return os.RemoveAll(lockDir)
		}); err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("remove stale runtime install lock: %w", err)
		}
		if err := os.Mkdir(lockDir, 0755); err != nil {
			if os.IsExist(err) {
				return nil, fmt.Errorf("runtime installation is already locked by another process")
			}
			return nil, err
		}
	}

	lockInfo := []byte(fmt.Sprintf("pid=%d\ncreated_at=%s\n", os.Getpid(), time.Now().UTC().Format(time.RFC3339Nano)))
	if err := os.WriteFile(filepath.Join(lockDir, "owner"), lockInfo, 0644); err != nil {
		_ = os.RemoveAll(lockDir)
		return nil, fmt.Errorf("write runtime install lock metadata: %w", err)
	}

	return func() {
		_ = runWithRetry(func() error {
			return os.RemoveAll(lockDir)
		})
	}, nil
}

func lockDirIsStale(lockDir string) (bool, error) {
	info, err := os.Stat(lockDir)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return time.Since(info.ModTime()) > installLockStaleAfter, nil
}

func createStageDir(rootDir string) (string, func(), error) {
	stageParent := filepath.Join(filepath.Dir(rootDir), ".staging")
	if err := runWithRetry(func() error {
		return os.MkdirAll(stageParent, 0755)
	}); err != nil {
		return "", nil, err
	}

	stageName := fmt.Sprintf("%s-%d-%d", filepath.Base(rootDir), time.Now().UnixNano(), rand.Int63())
	stageDir := filepath.Join(stageParent, stageName)
	if err := os.Mkdir(stageDir, 0755); err != nil {
		return "", nil, fmt.Errorf("create staged runtime dir: %w", err)
	}

	cleanup := func() {
		_ = runWithRetry(func() error {
			return os.RemoveAll(stageDir)
		})
	}
	return stageDir, cleanup, nil
}

func replaceDir(targetDir, stageDir string) error {
	if err := runWithRetry(func() error {
		return os.RemoveAll(targetDir)
	}); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove incomplete runtime dir: %w", err)
	}
	if err := runWithRetry(func() error {
		return os.Rename(stageDir, targetDir)
	}); err != nil {
		return fmt.Errorf("promote staged runtime dir: %w", err)
	}
	return nil
}

func loadInstallState(rootDir string) *installState {
	if state, ok := installStates.Load(rootDir); ok {
		return state.(*installState)
	}

	state := &installState{}
	actual, _ := installStates.LoadOrStore(rootDir, state)
	return actual.(*installState)
}

func (o InstallOptions) validate() error {
	if o.RootDir == "" {
		return fmt.Errorf("runtime install root dir is required")
	}
	if o.Verify == nil {
		return fmt.Errorf("runtime install verify function is required")
	}
	if o.Install == nil {
		return fmt.Errorf("runtime install callback is required")
	}
	return nil
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
