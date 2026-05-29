// Test-only helpers. Keeping mock builders out of focus.go so they don't
// inflate the production binary.

package main

import deskact "github.com/PekingSpades/DeskAct"

func mockWindowInfo(id uint64, pid int, title string) deskact.WindowInfo {
	return deskact.WindowInfo{
		ID:          id,
		PID:         pid,
		Title:       title,
		Bounds:      deskact.Rect{},
		IsVisible:   true,
		IsMinimized: false,
	}
}
