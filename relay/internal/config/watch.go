package config

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"time"
)

type WatchEventKind string

const (
	WatchEventChanged WatchEventKind = "changed"
	WatchEventDeleted WatchEventKind = "deleted"
	WatchEventError   WatchEventKind = "error"
)

type WatchEvent struct {
	Kind   WatchEventKind
	Path   string
	Config *Config
	Err    error
}

type Watcher struct {
	path     string
	interval time.Duration
	onEvent  func(WatchEvent)
}

type watchFingerprint struct {
	exists bool
	hash   string
}

func NewWatcher(path string, interval time.Duration, onEvent func(WatchEvent)) *Watcher {
	if interval <= 0 {
		interval = 1500 * time.Millisecond
	}
	return &Watcher{
		path:     path,
		interval: interval,
		onEvent:  onEvent,
	}
}

func (w *Watcher) Start(ctx context.Context) {
	prev, _ := w.fingerprint()
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			next, err := w.fingerprint()
			if err != nil {
				w.emit(WatchEvent{
					Kind: WatchEventError,
					Path: w.path,
					Err:  err,
				})
				continue
			}

			if next == prev {
				continue
			}

			prev = next
			if !next.exists {
				w.emit(WatchEvent{
					Kind: WatchEventDeleted,
					Path: w.path,
				})
				continue
			}

			cfg, err := Load(w.path)
			if err != nil {
				w.emit(WatchEvent{
					Kind: WatchEventError,
					Path: w.path,
					Err:  err,
				})
				continue
			}

			w.emit(WatchEvent{
				Kind:   WatchEventChanged,
				Path:   w.path,
				Config: Clone(cfg),
			})
		}
	}
}

func (w *Watcher) emit(evt WatchEvent) {
	if w.onEvent == nil {
		return
	}
	w.onEvent(evt)
}

func (w *Watcher) fingerprint() (watchFingerprint, error) {
	data, err := os.ReadFile(w.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return watchFingerprint{}, nil
		}
		return watchFingerprint{}, fmt.Errorf("read watch target: %w", err)
	}

	sum := sha256.Sum256(data)
	return watchFingerprint{
		exists: true,
		hash:   hex.EncodeToString(sum[:]),
	}, nil
}
