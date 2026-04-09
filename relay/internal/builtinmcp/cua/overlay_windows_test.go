//go:build windows && desktop_cua

package cua

import (
	"testing"
	"time"
)

func TestWindowsOverlayNeedsAnimation(t *testing.T) {
	now := time.Now()

	if windowsOverlayNeedsAnimation(windowsOverlayState{}, now) {
		t.Fatal("expected hidden overlay to skip animation")
	}

	if windowsOverlayNeedsAnimation(windowsOverlayState{Visible: true}, now) {
		t.Fatal("expected static visible overlay to skip animation")
	}

	if !windowsOverlayNeedsAnimation(windowsOverlayState{
		Visible:    true,
		PulseUntil: now.Add(100 * time.Millisecond),
	}, now) {
		t.Fatal("expected active pulse to require animation")
	}
}
