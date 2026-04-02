package commandline

import (
	"fmt"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

func (s *Server) buildTools() []core.Tool {
	tools := make([]core.Tool, 0, 1)

	if _, err := s.resolveBashBinary(); err == nil {
		tools = append(tools, core.Tool{
			Name:        "bash",
			Description: "Execute one bash command with the relay commandline runtime. Prefer dedicated filesystem tools for path discovery, search, reads, and edits when available. Use cwd instead of relying on cd or shell state across calls. Returns stdout, stderr, exitCode, and timeout metadata. The bundled environment places bash, git, node, python, ffmpeg, ffprobe, and managed cli-anything wrappers on PATH.",
			InputSchema: s.shellSchema(),
		})
	}

	return tools
}

func (s *Server) shellSchema() map[string]interface{} {
	return objectSchema(map[string]interface{}{
		"command":        stringSchema("One shell command string to execute. If subcommands depend on each other, chain them inside this command."),
		"execution_mode": executionModeSchema(),
		"cwd":            stringSchema("Optional working directory for this invocation only. Defaults to the builtin default_cwd when configured. Shell state does not persist across tool calls."),
		"timeout_sec":    s.timeoutSchema(),
		"env":            envSchema(),
	}, []string{"command"})
}

func (s *Server) timeoutSchema() map[string]interface{} {
	maximum := int64(3600)
	description := "Optional timeout in seconds."
	if s.cfg.MaxTimeout > 0 {
		maximum = int64(s.cfg.MaxTimeout / time.Second)
		description = fmt.Sprintf("Optional timeout in seconds. When omitted, relay uses %d seconds. Requests above that are capped.", maximum)
	}
	return map[string]interface{}{
		"type":        "integer",
		"description": description,
		"minimum":     1,
		"maximum":     maximum,
	}
}

func envSchema() map[string]interface{} {
	return map[string]interface{}{
		"type":        "object",
		"description": "Optional environment variables to merge into the process environment for this invocation only.",
		"additionalProperties": map[string]interface{}{
			"type": "string",
		},
	}
}

func executionModeSchema() map[string]interface{} {
	return map[string]interface{}{
		"type":        "string",
		"description": "Optional execution mode. Use `async` when the caller may return immediately and receive the final result later through Synapse's deferred tool-call flow.",
		"enum":        []string{"sync", "async"},
	}
}

func objectSchema(properties map[string]interface{}, required []string) map[string]interface{} {
	if properties == nil {
		properties = map[string]interface{}{}
	}
	return map[string]interface{}{
		"type":       "object",
		"properties": properties,
		"required":   required,
	}
}

func stringSchema(description string) map[string]interface{} {
	return map[string]interface{}{
		"type":        "string",
		"description": description,
	}
}
