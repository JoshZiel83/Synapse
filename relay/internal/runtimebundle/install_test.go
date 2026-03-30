package runtimebundle

import (
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestEnsurePublishesStageAtomically(t *testing.T) {
	rootDir := filepath.Join(t.TempDir(), "runtime", "bundle-v1")
	installStarted := make(chan struct{})
	allowPublish := make(chan struct{})

	verify := func(dir string) bool {
		ready, err := os.ReadFile(filepath.Join(dir, ".ready"))
		if err != nil || string(ready) != "bundle-v1" {
			return false
		}
		_, err = os.Stat(filepath.Join(dir, "payload.txt"))
		return err == nil
	}

	err := Ensure(InstallOptions{
		RootDir: rootDir,
		Verify:  verify,
		Install: func(stageDir string) error {
			if err := WriteFile(filepath.Join(stageDir, "payload.txt"), []byte("ok"), 0644); err != nil {
				return err
			}
			close(installStarted)
			<-allowPublish
			return os.WriteFile(filepath.Join(stageDir, ".ready"), []byte("bundle-v1"), 0644)
		},
	})
	if !IsPending(err) {
		t.Fatalf("expected initial ensure to return pending, got %v", err)
	}

	select {
	case <-installStarted:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for staged install to start")
	}

	if verify(rootDir) {
		t.Fatalf("expected target runtime dir to stay unready until publish completes")
	}
	if _, err := os.Stat(filepath.Join(rootDir, "payload.txt")); err == nil {
		t.Fatalf("expected staged payload to stay hidden before atomic publish")
	}

	close(allowPublish)

	waitForReady(t, rootDir, verify)
}

func TestEnsureRetriesAfterFailedAttempt(t *testing.T) {
	rootDir := filepath.Join(t.TempDir(), "runtime", "bundle-v2")
	var attempts atomic.Int32

	verify := func(dir string) bool {
		ready, err := os.ReadFile(filepath.Join(dir, ".ready"))
		if err != nil || string(ready) != "bundle-v2" {
			return false
		}
		_, err = os.Stat(filepath.Join(dir, "payload.txt"))
		return err == nil
	}

	err := Ensure(InstallOptions{
		RootDir: rootDir,
		Verify:  verify,
		Install: func(stageDir string) error {
			currentAttempt := attempts.Add(1)
			if currentAttempt == 1 {
				return errors.New("boom")
			}
			if err := WriteFile(filepath.Join(stageDir, "payload.txt"), []byte("ok"), 0644); err != nil {
				return err
			}
			return os.WriteFile(filepath.Join(stageDir, ".ready"), []byte("bundle-v2"), 0644)
		},
	})
	if !IsPending(err) {
		t.Fatalf("expected initial ensure to return pending, got %v", err)
	}

	waitForCondition(t, func() bool {
		return attempts.Load() == 1
	})

	if verify(rootDir) {
		t.Fatalf("expected failed attempt not to publish a partial runtime")
	}

	err = Ensure(InstallOptions{
		RootDir: rootDir,
		Verify:  verify,
		Install: func(stageDir string) error {
			currentAttempt := attempts.Add(1)
			if currentAttempt == 1 {
				return errors.New("boom")
			}
			if err := WriteFile(filepath.Join(stageDir, "payload.txt"), []byte("ok"), 0644); err != nil {
				return err
			}
			return os.WriteFile(filepath.Join(stageDir, ".ready"), []byte("bundle-v2"), 0644)
		},
	})
	if !IsPending(err) {
		t.Fatalf("expected retry ensure to remain pending while background retry runs, got %v", err)
	}

	waitForReady(t, rootDir, verify)

	if got := attempts.Load(); got != 2 {
		t.Fatalf("expected exactly two install attempts, got %d", got)
	}
}

func waitForReady(t *testing.T, rootDir string, verify func(string) bool) {
	t.Helper()
	waitForCondition(t, func() bool {
		err := Ensure(InstallOptions{
			RootDir: rootDir,
			Verify:  verify,
			Install: func(stageDir string) error {
				return os.WriteFile(filepath.Join(stageDir, ".ready"), []byte("unused"), 0644)
			},
		})
		return err == nil && verify(rootDir)
	})
}

func waitForCondition(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("condition was not satisfied before timeout")
}
