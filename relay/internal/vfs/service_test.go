package vfs

import "testing"

func TestNormalizePath(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "", want: "/"},
		{input: "/", want: "/"},
		{input: "/browser/demo", want: "/browser/demo"},
		{input: "browser/demo", want: "/browser/demo"},
		{input: "relayfs://browser/demo/sessions/default/current/snapshot.txt", want: "/browser/demo/sessions/default/current/snapshot.txt"},
	}

	for _, tc := range tests {
		got, err := normalizePath(tc.input)
		if err != nil {
			t.Fatalf("normalizePath(%q) error: %v", tc.input, err)
		}
		if got != tc.want {
			t.Fatalf("normalizePath(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestSplitPath(t *testing.T) {
	got := splitPath("/browser/demo/sessions/default")
	want := []string{"browser", "demo", "sessions", "default"}
	if len(got) != len(want) {
		t.Fatalf("splitPath length = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("splitPath[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}
