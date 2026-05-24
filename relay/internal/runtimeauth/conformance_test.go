package runtimeauth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// fixturesDir is relative to this test file. Going up four directories from
// relay/internal/runtimeauth/ lands at the repository root.
func fixturesDir(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	return filepath.Join(
		wd, "..", "..", "..",
		"packages", "shared", "test-fixtures", "runtime-auth",
	)
}

func loadFixture(t *testing.T, name string, out interface{}) {
	t.Helper()
	path := filepath.Join(fixturesDir(t), name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		t.Fatalf("decode fixture %s: %v", name, err)
	}
}

type filesystemFixture struct {
	Description string `json:"description"`
	Policies    []struct {
		Capability string            `json:"capability"`
		Filesystem *FilesystemPolicy `json:"filesystem,omitempty"`
		CUA        *CUAPolicy        `json:"cua,omitempty"`
	} `json:"policies"`
	Request struct {
		Access       string   `json:"access"`
		PathPrefixes []string `json:"pathPrefixes"`
	} `json:"request"`
	Expected bool `json:"expected"`
}

type cuaFixture struct {
	Description string `json:"description"`
	Policies    []struct {
		Capability string            `json:"capability"`
		CUA        *CUAPolicy        `json:"cua,omitempty"`
		Filesystem *FilesystemPolicy `json:"filesystem,omitempty"`
	} `json:"policies"`
	Request struct {
		Access string `json:"access"`
	} `json:"request"`
	Expected bool `json:"expected"`
}

type browserFixture struct {
	Description string `json:"description"`
	Policies    []struct {
		Capability string         `json:"capability"`
		Browser    *BrowserPolicy `json:"browser,omitempty"`
	} `json:"policies"`
	Request struct {
		Action            string `json:"action"`
		Origin            string `json:"origin"`
		Host              string `json:"host"`
		RegistrableDomain string `json:"registrableDomain"`
	} `json:"request"`
	Expected bool `json:"expected"`
}

type commandlineFixture struct {
	Description string `json:"description"`
	Policies    []struct {
		Capability  string             `json:"capability"`
		Commandline *CommandlinePolicy `json:"commandline,omitempty"`
	} `json:"policies"`
	Request struct {
		Executor         string `json:"executor"`
		CommandText      string `json:"commandText"`
		WorkingDirectory string `json:"workingDirectory"`
	} `json:"request"`
	Expected bool `json:"expected"`
}

// policiesForCapability filters a fixture's policies to just the ones for a
// given capability, normalizing each through the same path the relay would
// use when receiving authorization specs from the API.
func policiesForCapability[T any](
	all []T, capability string, extract func(T) (string, GrantPolicy),
) []GrantPolicy {
	out := make([]GrantPolicy, 0, len(all))
	for _, raw := range all {
		cap, policy := extract(raw)
		if cap != capability {
			continue
		}
		out = append(out, normalizeGrantPolicy(policy))
	}
	return out
}

func TestConformanceFilesystem(t *testing.T) {
	var fixtures []filesystemFixture
	loadFixture(t, "filesystem.json", &fixtures)
	if len(fixtures) == 0 {
		t.Fatalf("no filesystem fixtures loaded")
	}
	for _, fx := range fixtures {
		t.Run(fx.Description, func(t *testing.T) {
			policies := policiesForCapability(
				fx.Policies, "filesystem",
				func(p struct {
					Capability string            `json:"capability"`
					Filesystem *FilesystemPolicy `json:"filesystem,omitempty"`
					CUA        *CUAPolicy        `json:"cua,omitempty"`
				}) (string, GrantPolicy) {
					return p.Capability, GrantPolicy{
						Capability: "filesystem",
						Filesystem: p.Filesystem,
					}
				},
			)
			got := MatchesFilesystemPolicy(
				policies,
				fx.Request.Access,
				fx.Request.PathPrefixes,
			)
			if got != fx.Expected {
				t.Fatalf("expected %v, got %v", fx.Expected, got)
			}
		})
	}
}

func TestConformanceCUA(t *testing.T) {
	var fixtures []cuaFixture
	loadFixture(t, "cua.json", &fixtures)
	for _, fx := range fixtures {
		t.Run(fx.Description, func(t *testing.T) {
			policies := policiesForCapability(
				fx.Policies, "cua",
				func(p struct {
					Capability string            `json:"capability"`
					CUA        *CUAPolicy        `json:"cua,omitempty"`
					Filesystem *FilesystemPolicy `json:"filesystem,omitempty"`
				}) (string, GrantPolicy) {
					return p.Capability, GrantPolicy{
						Capability: "cua",
						CUA:        p.CUA,
					}
				},
			)
			got := MatchesCUAPolicy(policies, fx.Request.Access)
			if got != fx.Expected {
				t.Fatalf("expected %v, got %v", fx.Expected, got)
			}
		})
	}
}

func TestConformanceBrowser(t *testing.T) {
	var fixtures []browserFixture
	loadFixture(t, "browser.json", &fixtures)
	for _, fx := range fixtures {
		t.Run(fx.Description, func(t *testing.T) {
			policies := policiesForCapability(
				fx.Policies, "browser",
				func(p struct {
					Capability string         `json:"capability"`
					Browser    *BrowserPolicy `json:"browser,omitempty"`
				}) (string, GrantPolicy) {
					return p.Capability, GrantPolicy{
						Capability: "browser",
						Browser:    p.Browser,
					}
				},
			)
			got := MatchesBrowserPolicy(
				policies,
				fx.Request.Action,
				fx.Request.Origin,
				fx.Request.Host,
				fx.Request.RegistrableDomain,
			)
			if got != fx.Expected {
				t.Fatalf("expected %v, got %v", fx.Expected, got)
			}
		})
	}
}

func TestConformanceCommandline(t *testing.T) {
	var fixtures []commandlineFixture
	loadFixture(t, "commandline.json", &fixtures)
	for _, fx := range fixtures {
		t.Run(fx.Description, func(t *testing.T) {
			policies := policiesForCapability(
				fx.Policies, "commandline",
				func(p struct {
					Capability  string             `json:"capability"`
					Commandline *CommandlinePolicy `json:"commandline,omitempty"`
				}) (string, GrantPolicy) {
					return p.Capability, GrantPolicy{
						Capability:  "commandline",
						Commandline: p.Commandline,
					}
				},
			)
			got := MatchesCommandlinePolicy(
				policies,
				fx.Request.Executor,
				fx.Request.CommandText,
				fx.Request.WorkingDirectory,
			)
			if got != fx.Expected {
				t.Fatalf("expected %v, got %v", fx.Expected, got)
			}
		})
	}
}
