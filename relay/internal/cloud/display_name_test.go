package cloud

import "testing"

func TestResolveRelayDisplayNamePrefersExplicitValue(t *testing.T) {
	if got := ResolveRelayDisplayName("  My Relay  "); got != "My Relay" {
		t.Fatalf("expected explicit display name to win, got %q", got)
	}
}

func TestPlatformDisplayName(t *testing.T) {
	cases := map[string]string{
		"windows": "Windows",
		"darwin":  "macOS",
		"linux":   "Linux",
		"freebsd": "Freebsd",
		"":        "Device",
	}
	for input, want := range cases {
		if got := platformDisplayName(input); got != want {
			t.Fatalf("platformDisplayName(%q) = %q, want %q", input, got, want)
		}
	}
}
