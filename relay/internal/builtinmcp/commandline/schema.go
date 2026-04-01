package commandline

import (
	"fmt"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

func (s *Server) buildTools() []core.Tool {
	tools := make([]core.Tool, 0, 4)

	if _, err := s.resolveBashBinary(); err == nil {
		tools = append(tools, core.Tool{
			Name:        "bash_exec",
			Description: "Execute one bash command for shell-only tasks. Prefer GlobTool for filename or path discovery, GrepTool for current regex content search, SearchFiles for indexed broad discovery, dedicated filesystem tools for reading or editing files, and git_exec for git operations. Do not use bash_exec for find/grep/rg-style filesystem search when a dedicated tool fits. Use cwd instead of relying on cd or shell state across calls. Returns stdout, stderr, exitCode, and timeout metadata. On Windows this uses the bundled Git Bash runtime when present. Bundled command line runtimes also place ffmpeg and ffprobe on PATH.",
			InputSchema: s.shellSchema(),
		})
	}
	if _, err := s.resolveGitBinary(); err == nil {
		tools = append(tools, core.Tool{
			Name:        "git_exec",
			Description: "Run one git command with argv-style arguments. Prefer this over bash_exec for git status, diff, log, show, add, commit, and similar git operations. Returns stdout, stderr, exitCode, and timeout metadata.",
			InputSchema: s.gitSchema(),
		})
	}
	if _, err := s.resolveNodeBinary(); err == nil {
		tools = append(tools, core.Tool{
			Name:        "node_exec",
			Description: "Run JavaScript with the bundled Node runtime. Use this when dedicated tools and bash_exec are insufficient and you need custom JS logic or bundled parsing libraries. Prefer dedicated filesystem tools for ordinary file reads, searches, and edits. Returns stdout, stderr, exitCode, and timeout metadata. Bundled packages cover HTTP, HTML/XML, CSV/Excel, image processing, ZIP/TAR archives, audio metadata, lightweight media parsing, PDF, and Office document processing. Notable packages include axios, cheerio, csv-parse, csv-stringify, fast-xml-parser, xml2js, jszip, adm-zip, archiver, extract-zip, unzipper, tar, jimp, image-size, music-metadata, node-id3, wavefile, xlsx, exceljs, pptxgenjs, docx, mammoth, pdf-parse, pdf-lib, yaml, toml, and ini. The bundled environment also places ffmpeg and ffprobe on PATH. Prefer CommonJS require() for bundled package imports.",
			InputSchema: s.codeSchema("JavaScript source to execute with `node -e`."),
		})
	}
	if _, err := s.resolvePythonBinary(); err == nil {
		tools = append(tools, core.Tool{
			Name:        "python_exec",
			Description: "Run Python code with the bundled Python runtime. Use this when dedicated tools and bash_exec are insufficient and you need custom Python logic or bundled data-processing libraries. Prefer dedicated filesystem tools for ordinary file reads, searches, and edits. Returns stdout, stderr, exitCode, and timeout metadata. Bundled packages cover HTTP, HTML/XML, pandas-style data processing, Excel, PDF, image handling, audio metadata, audio or video helper workflows, QR code generation, compressed archives, and Office document processing. Notable packages include requests, httpx, aiohttp, beautifulsoup4, lxml, pandas, openpyxl, xlrd, pyxlsb, pypdf, pdfplumber, Pillow, imageio, imageio-ffmpeg, mutagen, pydub, tinytag, py7zr, pyzipper, qrcode, python-docx, python-pptx, and PyYAML. The bundled environment also places ffmpeg and ffprobe on PATH.",
			InputSchema: s.codeSchema("Python source to execute with `python -c`."),
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

func (s *Server) gitSchema() map[string]interface{} {
	return objectSchema(map[string]interface{}{
		"args": map[string]interface{}{
			"type":        "array",
			"description": "Git argv list for a single invocation, for example [\"status\", \"--short\"].",
			"items": map[string]interface{}{
				"type": "string",
			},
		},
		"execution_mode": executionModeSchema(),
		"cwd":            stringSchema("Optional working directory for this invocation only. Defaults to the builtin default_cwd when configured."),
		"timeout_sec":    s.timeoutSchema(),
		"env":            envSchema(),
	}, []string{"args"})
}

func (s *Server) codeSchema(description string) map[string]interface{} {
	return objectSchema(map[string]interface{}{
		"code":           stringSchema(description),
		"execution_mode": executionModeSchema(),
		"cwd":            stringSchema("Optional working directory for this invocation only. Defaults to the builtin default_cwd when configured."),
		"timeout_sec":    s.timeoutSchema(),
		"env":            envSchema(),
	}, []string{"code"})
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
