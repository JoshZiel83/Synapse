// focusStore pure-logic unit tests. Mostly avoids DeskAct calls — the goal
// is to lock in the bookkeeping invariants (default focus, generation
// monotonicity, isolation between sessions, TTL/cap eviction) without
// depending on a display/window manager being available. One test
// (TestWindowDTOForFocusFallsBackOnRefreshMiss) does exercise
// windowDTOForFocus → refreshWindowInfo, which calls ListWindows; in a
// headless test env ListWindows reports unsupported and the test verifies
// the fallback path.

package main

import (
	"strconv"
	"testing"
	"time"

	deskact "github.com/PekingSpades/DeskAct"
)

func TestNormalizeSessionID(t *testing.T) {
	cases := map[string]string{
		"":               defaultSessionID,
		defaultSessionID: defaultSessionID,
		"session:abc":    "session:abc",
	}
	for in, want := range cases {
		if got := normalizeSessionID(in); got != want {
			t.Errorf("normalizeSessionID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseWindowID(t *testing.T) {
	cases := []struct {
		in      string
		want    uint64
		wantErr bool
	}{
		{"0", 0, false},
		{"42", 42, false},
		{"18446744073709551615", 1<<64 - 1, false}, // max uint64, beyond JS safe-int
		{"0x10", 16, false},
		{"0XAB", 0xab, false},
		{" 7 ", 7, false},
		{"", 0, true},
		{"not-a-number", 0, true},
		{"-1", 0, true},
	}
	for _, c := range cases {
		got, err := parseWindowID(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("parseWindowID(%q) expected error, got %v", c.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseWindowID(%q) unexpected error: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("parseWindowID(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestFormatWindowIDHex(t *testing.T) {
	if got := formatWindowIDHex(255); got != "0xff" {
		t.Errorf("got %q, want 0xff", got)
	}
	if got := formatWindowIDHex(0); got != "0x0" {
		t.Errorf("got %q, want 0x0", got)
	}
}

func TestDefaultFocus(t *testing.T) {
	f := defaultFocus()
	if f.Target != focusTargetDisplay {
		t.Errorf("default target = %q, want %q", f.Target, focusTargetDisplay)
	}
	if f.DisplayIndex != 0 {
		t.Errorf("default display index = %d, want 0", f.DisplayIndex)
	}
	if f.CoordinateSpace != coordDisplayPixels {
		t.Errorf("default coordinate space = %q, want %q", f.CoordinateSpace, coordDisplayPixels)
	}
}

func TestFocusStoreGetMaterializesDefault(t *testing.T) {
	s := newFocusStore()
	f := s.get("session-1")
	if f.Target != focusTargetDisplay {
		t.Errorf("got target %q, want display", f.Target)
	}
	if f.CoordinateSpace != coordDisplayPixels {
		t.Errorf("got coord %q, want display_pixels", f.CoordinateSpace)
	}
	if got := s.size(); got != 1 {
		t.Errorf("store size = %d, want 1", got)
	}
}

func TestFocusStoreDefaultIDIsCoalesced(t *testing.T) {
	s := newFocusStore()
	f1 := s.get("")
	f2 := s.get(defaultSessionID)
	if got := s.size(); got != 1 {
		t.Errorf("empty and 'default' should share an entry; size = %d, want 1", got)
	}
	if f1.Target != f2.Target {
		t.Errorf("expected same focus for '' and 'default'")
	}
}

func TestSetDisplayBumpsGenerationMonotonically(t *testing.T) {
	s := newFocusStore()
	a1 := s.setDisplay("a", 0, 100)
	a2 := s.setDisplay("a", 1, 101)
	b1 := s.setDisplay("b", 0, 100)
	if a1.Generation >= a2.Generation {
		t.Errorf("generation should increase; a1=%d a2=%d", a1.Generation, a2.Generation)
	}
	if b1.Generation <= a2.Generation {
		t.Errorf("cross-session generation should still be monotonic; a2=%d b1=%d", a2.Generation, b1.Generation)
	}
	// CoordinateSpace must flip back to display each time.
	if a2.CoordinateSpace != coordDisplayPixels {
		t.Errorf("expected display_pixels, got %q", a2.CoordinateSpace)
	}
}

func TestSetWindowSwitchesCoordinateSpace(t *testing.T) {
	s := newFocusStore()
	s.setDisplay("a", 0, 100)
	// Simulate a window discovered by ListWindows.
	info := mockWindowInfo(0xABCD, 4242, "Editor")
	f := s.setWindow("a", info)
	if f.CoordinateSpace != coordWindowPixels {
		t.Errorf("expected window_pixels, got %q", f.CoordinateSpace)
	}
	if f.WindowID != 0xABCD {
		t.Errorf("expected window id 0xABCD, got %x", f.WindowID)
	}
	if f.PID != 4242 {
		t.Errorf("expected PID 4242, got %d", f.PID)
	}
	if f.Title != "Editor" {
		t.Errorf("expected title preserved, got %q", f.Title)
	}
}

func TestSessionsAreIsolated(t *testing.T) {
	s := newFocusStore()
	s.setDisplay("a", 0, 100)
	s.setWindow("b", mockWindowInfo(0xDEAD, 1234, "B"))
	fa := s.get("a")
	fb := s.get("b")
	if fa.Target != focusTargetDisplay {
		t.Errorf("session a polluted; target=%q", fa.Target)
	}
	if fb.Target != focusTargetWindow {
		t.Errorf("session b polluted; target=%q", fb.Target)
	}
	if fa.WindowID == fb.WindowID {
		t.Errorf("sessions share window id; bug")
	}
}

func TestRepeatedSetDisplaySameSessionStillBumpsGeneration(t *testing.T) {
	s := newFocusStore()
	g0 := s.setDisplay("a", 0, 100).Generation
	g1 := s.setDisplay("a", 0, 100).Generation
	g2 := s.setDisplay("a", 0, 100).Generation
	if !(g0 < g1 && g1 < g2) {
		t.Errorf("expected monotonic generations even for identical focus, got %d %d %d", g0, g1, g2)
	}
}

func TestSweepRemovesExpiredEntries(t *testing.T) {
	s := newFocusStore()
	now := time.Unix(1_000_000_000, 0)
	s.now = func() time.Time { return now }
	s.setDisplay("old", 0, 100)
	// Advance clock past TTL.
	now = now.Add(focusTTL + time.Minute)
	// Adding a new entry triggers sweepLocked, which removes "old".
	s.setDisplay("fresh", 0, 100)
	if got := s.size(); got != 1 {
		t.Errorf("expected expired 'old' to be swept; size=%d", got)
	}
}

func TestSweepEvictsOldestWhenAtCap(t *testing.T) {
	s := newFocusStore()
	base := time.Unix(1_000_000_000, 0)
	// Insert focusCap entries with strictly increasing timestamps. We have to
	// drive `now` because the store stamps UpdatedAt from `now()`.
	for i := 0; i < focusCap; i++ {
		idx := i
		s.now = func() time.Time { return base.Add(time.Duration(idx) * time.Second) }
		s.setDisplay("s"+strconv.Itoa(i), 0, 100)
	}
	if got := s.size(); got != focusCap {
		t.Fatalf("expected exactly focusCap=%d entries, got %d", focusCap, got)
	}
	// One more insert should evict the oldest ("s0") and land at exactly
	// focusCap total.
	s.now = func() time.Time { return base.Add(time.Duration(focusCap) * time.Second) }
	s.setDisplay("after-cap", 0, 100)
	if got := s.size(); got != focusCap {
		t.Errorf("expected cap to be honored; size=%d, want %d", got, focusCap)
	}
	if _, present := s.sessions["s0"]; present {
		t.Errorf("expected oldest session 's0' to be evicted")
	}
	if _, present := s.sessions["after-cap"]; !present {
		t.Errorf("expected new session 'after-cap' to be present")
	}
}

func TestTouchUpdatesTimestamp(t *testing.T) {
	s := newFocusStore()
	t0 := time.Unix(1_000_000_000, 0)
	s.now = func() time.Time { return t0 }
	s.setDisplay("a", 0, 100)
	first := s.sessions["a"].UpdatedAt
	t1 := t0.Add(5 * time.Minute)
	s.now = func() time.Time { return t1 }
	s.touch("a")
	second := s.sessions["a"].UpdatedAt
	if !second.After(first) {
		t.Errorf("touch did not update UpdatedAt: first=%v second=%v", first, second)
	}
	// touch must not bump generation.
	if s.sessions["a"].Generation != 1 {
		t.Errorf("touch must not bump generation; got %d", s.sessions["a"].Generation)
	}
}

// Read-path materialization (get / touch) must also honor focusCap. A busy
// device handling tons of cua_get_focus / cua_list_displays calls from
// short-lived sessions would otherwise blow past the bound — see review
// medium #2.
func TestGetEnforcesCapOnMaterialization(t *testing.T) {
	s := newFocusStore()
	base := time.Unix(1_000_000_000, 0)
	for i := 0; i < focusCap; i++ {
		idx := i
		s.now = func() time.Time { return base.Add(time.Duration(idx) * time.Second) }
		s.get("get-" + strconv.Itoa(i))
	}
	if got := s.size(); got != focusCap {
		t.Fatalf("expected exactly focusCap=%d entries after %d get() calls, got %d", focusCap, focusCap, got)
	}
	s.now = func() time.Time { return base.Add(time.Duration(focusCap) * time.Second) }
	s.get("get-after-cap")
	if got := s.size(); got != focusCap {
		t.Errorf("get() did not enforce cap; size=%d, want %d", got, focusCap)
	}
	if _, present := s.sessions["get-0"]; present {
		t.Errorf("expected oldest get-0 entry to be evicted by get()")
	}
}

func TestTouchEnforcesCapOnMaterialization(t *testing.T) {
	s := newFocusStore()
	base := time.Unix(1_000_000_000, 0)
	for i := 0; i < focusCap; i++ {
		idx := i
		s.now = func() time.Time { return base.Add(time.Duration(idx) * time.Second) }
		s.touch("touch-" + strconv.Itoa(i))
	}
	if got := s.size(); got != focusCap {
		t.Fatalf("expected focusCap entries after touch loop, got %d", got)
	}
	s.now = func() time.Time { return base.Add(time.Duration(focusCap) * time.Second) }
	s.touch("touch-after-cap")
	if got := s.size(); got != focusCap {
		t.Errorf("touch() did not enforce cap; size=%d, want %d", got, focusCap)
	}
	if _, present := s.sessions["touch-0"]; present {
		t.Errorf("expected oldest touch-0 entry to be evicted by touch()")
	}
}

func TestGetSweepsExpiredEntries(t *testing.T) {
	s := newFocusStore()
	now := time.Unix(1_000_000_000, 0)
	s.now = func() time.Time { return now }
	s.setDisplay("stale", 0, 100)
	now = now.Add(focusTTL + time.Minute)
	// Materializing a new entry via get() should also sweep the stale one.
	s.get("fresh")
	if _, present := s.sessions["stale"]; present {
		t.Errorf("expected stale entry to be swept by get(); still present")
	}
	if got := s.size(); got != 1 {
		t.Errorf("expected size=1 after sweep, got %d", got)
	}
}

// When ListWindows can't find the focused window (closed, unsupported
// platform — e.g. this headless test env), windowDTOForFocus must fall
// back to the focusStore snapshot and zero is_visible/is_minimized rather
// than emitting bogus fresh-looking metadata.
func TestWindowDTOForFocusFallsBackOnRefreshMiss(t *testing.T) {
	f := sessionFocus{
		Target:   focusTargetWindow,
		Mode:     focusModeBackground,
		WindowID: 0xDEADBEEF,
		PID:      4242,
		Title:    "Editor (snapshot)",
		Bounds:   deskact.Rect{Point: deskact.Point{X: 1, Y: 2}, Size: deskact.Size{W: 800, H: 600}},
	}
	dto := windowDTOForFocus(f)
	if dto == nil {
		t.Fatal("expected non-nil dto")
	}
	if dto.WindowID != "3735928559" { // decimal of 0xDEADBEEF
		t.Errorf("WindowID = %q, want decimal of 0xDEADBEEF", dto.WindowID)
	}
	if dto.WindowIDHex != "0xdeadbeef" {
		t.Errorf("WindowIDHex = %q, want 0xdeadbeef", dto.WindowIDHex)
	}
	if dto.PID != 4242 {
		t.Errorf("PID = %d, want 4242", dto.PID)
	}
	if dto.Title != "Editor (snapshot)" {
		t.Errorf("Title not preserved from snapshot; got %q", dto.Title)
	}
	if dto.Bounds.Width != 800 || dto.Bounds.Height != 600 {
		t.Errorf("Bounds not preserved from snapshot; got %+v", dto.Bounds)
	}
	// IsVisible / IsMinimized intentionally false on fallback so the model
	// can tell we couldn't confirm the window is still enumerable.
	if dto.IsVisible {
		t.Errorf("IsVisible should default to false on refresh miss")
	}
	if dto.IsMinimized {
		t.Errorf("IsMinimized should default to false on refresh miss")
	}
}
