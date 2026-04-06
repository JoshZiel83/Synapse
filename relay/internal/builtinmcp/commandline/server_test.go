package commandline

import (
	"context"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
)

func TestListToolsDescriptionsPreferDedicatedTools(t *testing.T) {
	server := &Server{
		cfg: Config{
			MaxTimeout: 45 * time.Second,
		},
	}

	tools := server.buildTools()
	if len(tools) == 0 {
		t.Skip("no commandline tools available in this environment")
	}

	descriptions := make(map[string]string, len(tools))
	for _, tool := range tools {
		descriptions[tool.Name] = tool.Description
	}

	description, ok := descriptions["bash"]
	if !ok {
		t.Fatalf("expected unified bash tool to be listed, got %#v", descriptions)
	}
	if !strings.Contains(description, "dedicated filesystem tools") {
		t.Fatalf("expected bash description to prefer dedicated filesystem tools, got %q", description)
	}
	if !strings.Contains(description, "git, node, python") {
		t.Fatalf("expected bash description to mention bundled runtimes, got %q", description)
	}
	if !strings.Contains(description, "cli-anything wrappers") {
		t.Fatalf("expected bash description to mention cli-anything wrappers, got %q", description)
	}

	schema := server.shellSchema()
	cwd := schema["properties"].(map[string]interface{})["cwd"].(map[string]interface{})
	if !strings.Contains(cwd["description"].(string), "Shell state does not persist") {
		t.Fatalf("expected shell cwd description to warn about shell state, got %q", cwd["description"])
	}
}

func TestResolveTimeoutDefaultsToConfiguredMax(t *testing.T) {
	server := &Server{
		cfg: Config{
			MaxTimeout: 45 * time.Second,
		},
	}

	timeout, err := server.resolveTimeout(map[string]interface{}{})
	if err != nil {
		t.Fatalf("resolve timeout: %v", err)
	}
	if timeout.Effective != 45*time.Second {
		t.Fatalf("expected default effective timeout 45s, got %s", timeout.Effective)
	}
	if !timeout.UsedDefault {
		t.Fatalf("expected timeout to use relay default")
	}
	if timeout.Capped {
		t.Fatalf("did not expect timeout to be capped")
	}
}

func TestResolveTimeoutCapsToConfiguredMax(t *testing.T) {
	server := &Server{
		cfg: Config{
			MaxTimeout: 30 * time.Second,
		},
	}

	timeout, err := server.resolveTimeout(map[string]interface{}{
		"timeout_sec": 120,
	})
	if err != nil {
		t.Fatalf("resolve timeout: %v", err)
	}
	if timeout.Requested != 120*time.Second {
		t.Fatalf("expected requested timeout 120s, got %s", timeout.Requested)
	}
	if timeout.Effective != 30*time.Second {
		t.Fatalf("expected capped effective timeout 30s, got %s", timeout.Effective)
	}
	if !timeout.Capped {
		t.Fatalf("expected timeout to be capped")
	}
	if timeout.UsedDefault {
		t.Fatalf("did not expect capped timeout to be marked as default")
	}
}

func TestTimeoutSchemaUsesConfiguredMaximum(t *testing.T) {
	server := &Server{
		cfg: Config{
			MaxTimeout: 90 * time.Second,
		},
	}

	schema := server.timeoutSchema()
	if got, ok := schema["maximum"].(int64); !ok || got != 90 {
		t.Fatalf("expected schema maximum 90, got %#v", schema["maximum"])
	}

	description, ok := schema["description"].(string)
	if !ok {
		t.Fatalf("expected schema description to be a string")
	}
	if !strings.Contains(description, "90 seconds") {
		t.Fatalf("expected schema description to mention 90 seconds, got %q", description)
	}
}

func TestDisabledCommandlineRequestsApprovalWithoutServerAuthorization(t *testing.T) {
	server := &Server{
		cfg: Config{
			Enabled: false,
		},
	}

	result, err := server.CallTool(context.Background(), "bash", map[string]interface{}{
		"command": "printf hello",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected disabled commandline server to require approval")
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	if structured["code"] != "server_disabled" {
		t.Fatalf("expected server_disabled code, got %#v", structured["code"])
	}
	denial, ok := structured["relay_access_denial"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected relay_access_denial map, got %#v", structured["relay_access_denial"])
	}
	if denial["kind"] != "permission_denied" {
		t.Fatalf("expected permission_denied kind, got %#v", denial["kind"])
	}
	if denial["resolution"] != "local_setting" {
		t.Fatalf("expected local_setting resolution, got %#v", denial["resolution"])
	}
}

func TestServerAuthorizationBypassesDisabledCommandline(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash execution test is Unix-only")
	}

	server := &Server{
		cfg: Config{
			Enabled:                  false,
			AllowServerAuthorization: true,
			MaxTimeout:               5 * time.Second,
		},
	}

	serverAuthorizedCtx := runtimeauth.ContextWithRuntimeAuthorization(
		context.Background(),
		runtimeauth.RuntimeAuthorization{
			GrantIDs: []string{"grant-cmd-1"},
			GrantSpecs: []map[string]interface{}{
				{
					"capability": "commandline",
					"commandline": map[string]interface{}{
						"executor":         "bash",
						"commandMatchType": "exact",
						"commandText":      "printf hello",
					},
				},
			},
		},
	)

	result, err := server.CallTool(serverAuthorizedCtx, "bash", map[string]interface{}{
		"command": "printf hello",
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if result.IsError {
		t.Fatalf("expected server-authorized commandline call to succeed, got %+v", result.StructuredContent)
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	if structured["stdout"] != "hello" {
		t.Fatalf("expected stdout hello, got %#v", structured["stdout"])
	}
}

func TestRunCommandRespectsEffectiveTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell timeout test is Unix-only")
	}

	binaryPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skipf("bash not available: %v", err)
	}

	server := &Server{}
	result := server.runCommand(
		context.Background(),
		"bash",
		binaryPath,
		[]string{"-lc", "sleep 2"},
		t.TempDir(),
		nil,
		resolvedTimeout{
			Effective:   100 * time.Millisecond,
			Max:         100 * time.Millisecond,
			UsedDefault: true,
		},
	)

	if !result.IsError {
		t.Fatalf("expected timed out command to return an error result")
	}

	structured, ok := result.StructuredContent.(map[string]interface{})
	if !ok {
		t.Fatalf("expected structured content map, got %T", result.StructuredContent)
	}
	if timedOut, ok := structured["timedOut"].(bool); !ok || !timedOut {
		t.Fatalf("expected timedOut=true, got %#v", structured["timedOut"])
	}
	if usedDefault, ok := structured["usedDefaultTimeout"].(bool); !ok || !usedDefault {
		t.Fatalf("expected usedDefaultTimeout=true, got %#v", structured["usedDefaultTimeout"])
	}
	if effective, ok := structured["effectiveTimeoutSec"].(float64); !ok || effective <= 0 || effective > 0.25 {
		t.Fatalf("expected short effective timeout, got %#v", structured["effectiveTimeoutSec"])
	}
}
