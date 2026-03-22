package commandline

import (
	"context"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

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
