package commandline

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/PekingSpades/Synapse/relay/internal/commandlinebundle"
)

func TestResolveCliAnythingWrapperPathFindsManagedWrapper(t *testing.T) {
	managedBinDir := t.TempDir()
	wrapperPath := filepath.Join(managedBinDir, "cli-anything-demo")
	if err := os.WriteFile(wrapperPath, []byte("#!/usr/bin/env bash\n"), 0644); err != nil {
		t.Fatalf("write wrapper: %v", err)
	}

	server := &Server{
		installation: &commandlinebundle.Installation{
			ManagedBinDir: managedBinDir,
		},
	}

	got := server.resolveManagedCommandPath("cli-anything-demo")
	if got != wrapperPath {
		t.Fatalf("expected wrapper path %q, got %q", wrapperPath, got)
	}
}

func TestResolveExistingPathExpandsTilde(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	targetPath := filepath.Join(homeDir, "Applications", "Demo.app", "Contents", "MacOS", "demo")
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		t.Fatalf("mkdirs: %v", err)
	}
	if err := os.WriteFile(targetPath, []byte("demo"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	got := resolveExistingPath("~/Applications/Demo.app/Contents/MacOS/demo")
	if got != targetPath {
		t.Fatalf("expected expanded path %q, got %q", targetPath, got)
	}
}

func TestResolveExecutableFromAugmentedSearchPathsFindsMacStyleTool(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
	toolPath := filepath.Join(homeDir, "bin", "demo-tool")
	if err := os.MkdirAll(filepath.Dir(toolPath), 0755); err != nil {
		t.Fatalf("mkdirs: %v", err)
	}
	if err := os.WriteFile(toolPath, []byte("demo"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	got := resolveExecutableFromAugmentedSearchPaths("demo-tool")
	if runtime.GOOS != "darwin" {
		t.Skip("darwin-only augmented PATH search is disabled on non-darwin builds")
	}
	if got != toolPath {
		t.Fatalf("expected augmented search path %q, got %q", toolPath, got)
	}
}

func TestProbeManagedCapabilityReturnsUnavailableReasonWithoutWrapper(t *testing.T) {
	server := &Server{}

	report := server.probeManagedCapability(commandlinebundle.ManagedCapability{
		Provider:            "notion-skills",
		ProviderDisplayName: "Notion Skills",
		Slug:                "ntn",
		Command:             "ntn",
		Version:             "0.5.6",
		UnavailableReason:   "Notion Skills is not officially supported on windows-amd64",
	})

	if ready, _ := report["ready"].(bool); ready {
		t.Fatalf("expected unsupported capability to remain unready")
	}
	if got, _ := report["reason"].(string); got != "Notion Skills is not officially supported on windows-amd64" {
		t.Fatalf("unexpected unavailable reason %q", got)
	}
}

func TestEvaluateManagedCapabilityProbeEnvAny(t *testing.T) {
	t.Setenv("ANYGEN_API_KEY", "test-key")

	server := &Server{}
	result := server.evaluateManagedCapabilityProbe(commandlinebundle.ManagedCapabilityProbe{
		Type:    "env_any",
		EnvVars: []string{"ANYGEN_API_KEY"},
	})

	if !result.ready {
		t.Fatalf("expected env_any probe to be ready, got reason %q", result.reason)
	}
	if got := result.details["resolvedEnvVar"]; got != "ANYGEN_API_KEY" {
		t.Fatalf("expected resolved env var ANYGEN_API_KEY, got %#v", got)
	}
}

func TestEvaluateManagedCapabilityProbeHTTPAny(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/version" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"version":"test"}`))
	}))
	defer server.Close()

	commandServer := &Server{}
	result := commandServer.evaluateManagedCapabilityProbe(commandlinebundle.ManagedCapabilityProbe{
		Type: "http_any",
		URLs: []string{server.URL + "/api/version"},
	})

	if !result.ready {
		t.Fatalf("expected http_any probe to be ready, got reason %q", result.reason)
	}
	if got := result.details["resolvedURL"]; got != server.URL+"/api/version" {
		t.Fatalf("expected resolved URL %q, got %#v", server.URL+"/api/version", got)
	}
}

func TestEvaluateManagedCapabilityProbeAllOfReturnsFirstFailure(t *testing.T) {
	server := &Server{}
	result := server.evaluateManagedCapabilityProbe(commandlinebundle.ManagedCapabilityProbe{
		Type: "all_of",
		AllOf: []commandlinebundle.ManagedCapabilityProbe{
			{
				Type:    "env_any",
				EnvVars: []string{"MISSING_TEST_ENV"},
			},
			{
				Type: "http_any",
				URLs: []string{"http://127.0.0.1:1/health"},
			},
		},
	})

	if result.ready {
		t.Fatalf("expected all_of probe to fail")
	}
	if got := result.reason; got == "" || got != "managed command wrapper is ready; dependency probe failed, set one of: MISSING_TEST_ENV" {
		t.Fatalf("unexpected all_of failure reason %q", got)
	}
}

func TestEvaluateManagedCapabilityProbePathAny(t *testing.T) {
	root := t.TempDir()
	targetDir := filepath.Join(root, "mubu-data")
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	server := &Server{}
	result := server.evaluateManagedCapabilityProbe(commandlinebundle.ManagedCapabilityProbe{
		Type:  "path_any",
		Paths: []string{targetDir},
	})

	if !result.ready {
		t.Fatalf("expected path_any probe to be ready, got reason %q", result.reason)
	}
	if got := result.details["resolvedPath"]; got != targetDir {
		t.Fatalf("expected resolved path %q, got %#v", targetDir, got)
	}
}

func TestEvaluateManagedCapabilityProbePythonImportAny(t *testing.T) {
	server := &Server{}
	result := server.evaluateManagedCapabilityProbe(commandlinebundle.ManagedCapabilityProbe{
		Type:       "python_import_any",
		Candidates: []string{"json"},
	})

	if !result.ready {
		t.Fatalf("expected python_import_any probe to be ready, got reason %q", result.reason)
	}
	if got := result.details["resolvedPythonModule"]; got != "json" {
		t.Fatalf("expected resolved module json, got %#v", got)
	}
}
