// focusStore — per-Agent-session CUA focus state.
//
// The TS device-runtime passes a stable `session_id` (server-signed
// cua_focus_scope_id) on every RPC. We keep the focus state — which display
// or background window the next click/type/capture should target — keyed by
// that id so a single Agent's cua_set_focus + cua_capture_view + cua_click
// sequence sees a consistent coordinate system, and concurrent Agents
// don't stomp on each other.
//
// Lifecycle: lazy sweep on every touch removes entries older than focusTTL;
// when the map exceeds focusCap we evict by oldest UpdatedAt down to cap-1.
// No background goroutine / timer — simpler and bounded.

package main

import (
	"sort"
	"sync"
	"time"

	deskact "github.com/PekingSpades/DeskAct"
)

const (
	defaultSessionID = "default"
	focusTTL         = 24 * time.Hour
	focusCap         = 1024
)

type focusTarget string

const (
	focusTargetDisplay focusTarget = "display"
	focusTargetWindow  focusTarget = "window"
)

type coordinateSpace string

const (
	coordDisplayPixels coordinateSpace = "display_pixels"
	coordWindowPixels  coordinateSpace = "window_pixels"
)

type focusMode string

const (
	focusModeBackground focusMode = "background"
)

// sessionFocus is the per-session state. Generation is monotonic across
// the whole store, not per session, so an Agent never sees a generation
// decrease between two writes — a small simplification that costs nothing.
type sessionFocus struct {
	Target          focusTarget
	Mode            focusMode
	DisplayIndex    int
	DisplayID       int
	WindowID        uint64
	PID             int32
	Title           string
	Bounds          deskact.Rect
	DisplayRegions  []deskact.WindowDisplayRegion
	CoordinateSpace coordinateSpace
	Generation      int64
	UpdatedAt       time.Time
}

func defaultFocus() sessionFocus {
	return sessionFocus{
		Target:          focusTargetDisplay,
		DisplayIndex:    0,
		CoordinateSpace: coordDisplayPixels,
	}
}

type focusStore struct {
	mu         sync.Mutex
	generation int64
	sessions   map[string]sessionFocus
	now        func() time.Time // injected for tests
}

func newFocusStore() *focusStore {
	return &focusStore{
		sessions: make(map[string]sessionFocus),
		now:      time.Now,
	}
}

func normalizeSessionID(id string) string {
	if id == "" {
		return defaultSessionID
	}
	return id
}

// get returns the current focus for sessionID, materializing a default-display
// entry on first access. Also bumps UpdatedAt so the entry is "touched".
//
// Read-path materialization is bounded by the same sweep / cap logic as
// writes — otherwise a busy device handling many cua_get_focus or
// cua_list_displays calls from short-lived sessions could push the map past
// focusCap. We only sweep when actually inserting a NEW entry so existing
// sessions don't pay per-call sweep overhead.
func (s *focusStore) get(sessionID string) sessionFocus {
	id := normalizeSessionID(sessionID)
	s.mu.Lock()
	defer s.mu.Unlock()
	f, ok := s.sessions[id]
	if !ok {
		s.sweepLocked()
		f = defaultFocus()
	}
	f.UpdatedAt = s.now()
	s.sessions[id] = f
	return f
}

// touch updates UpdatedAt for a session without changing the focus. Called
// from operation handlers (click/type/capture) that consume but don't mutate
// the focus. Sweeps on insert for the same reason as get().
func (s *focusStore) touch(sessionID string) {
	id := normalizeSessionID(sessionID)
	s.mu.Lock()
	defer s.mu.Unlock()
	f, ok := s.sessions[id]
	if !ok {
		s.sweepLocked()
		f = defaultFocus()
	}
	f.UpdatedAt = s.now()
	s.sessions[id] = f
}

// setDisplay records a display focus and bumps the generation. The caller
// must have already validated that displayIndex resolves to a real display
// — store.setDisplay performs no DeskAct calls so it stays testable.
func (s *focusStore) setDisplay(sessionID string, displayIndex int, displayID int) sessionFocus {
	id := normalizeSessionID(sessionID)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	s.generation++
	f := sessionFocus{
		Target:          focusTargetDisplay,
		DisplayIndex:    displayIndex,
		DisplayID:       displayID,
		CoordinateSpace: coordDisplayPixels,
		Generation:      s.generation,
		UpdatedAt:       s.now(),
	}
	s.sessions[id] = f
	return f
}

// setWindow records a background-window focus from a validated WindowInfo
// and bumps the generation.
func (s *focusStore) setWindow(sessionID string, info deskact.WindowInfo) sessionFocus {
	id := normalizeSessionID(sessionID)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	s.generation++
	f := sessionFocus{
		Target:          focusTargetWindow,
		Mode:            focusModeBackground,
		WindowID:        info.ID,
		PID:             int32(info.PID),
		Title:           info.Title,
		Bounds:          info.Bounds,
		DisplayRegions:  info.DisplayRegions,
		CoordinateSpace: coordWindowPixels,
		Generation:      s.generation,
		UpdatedAt:       s.now(),
	}
	s.sessions[id] = f
	return f
}

// size returns the current entry count (test-only convenience; takes the
// lock).
func (s *focusStore) size() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

// sweepLocked is called by mutating ops while holding the lock. It removes
// expired entries (UpdatedAt older than focusTTL) and — if the map still
// exceeds focusCap — evicts oldest entries until size is focusCap-1, so the
// caller's about-to-happen insert lands at size == focusCap exactly.
func (s *focusStore) sweepLocked() {
	now := s.now()
	for k, v := range s.sessions {
		if now.Sub(v.UpdatedAt) > focusTTL {
			delete(s.sessions, k)
		}
	}
	if len(s.sessions) < focusCap {
		return
	}
	type kv struct {
		k string
		t time.Time
	}
	all := make([]kv, 0, len(s.sessions))
	for k, v := range s.sessions {
		all = append(all, kv{k: k, t: v.UpdatedAt})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].t.Before(all[j].t) })
	// Evict oldest until we're at focusCap-1, so the immediately-following
	// insert reaches exactly focusCap.
	excess := len(s.sessions) - (focusCap - 1)
	for i := 0; i < excess && i < len(all); i++ {
		delete(s.sessions, all[i].k)
	}
}
