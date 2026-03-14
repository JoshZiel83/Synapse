package importer

import (
	"errors"
	"os"

	"github.com/PekingSpades/Synapse/relay/internal/config"
)

// Source represents a detected MCP config source (e.g. Claude Code, Codex)
type Source struct {
	Kind       string           `json:"kind"`
	SourceKey  string           `json:"sourceKey"`
	Name       string           `json:"name"`
	ConfigPath string           `json:"configPath"`
	Available  bool             `json:"available"`
	Servers    []ImportedServer `json:"servers,omitempty"`
	Error      string           `json:"error,omitempty"`
}

// ImportedServer represents a single MCP server parsed from an external config
type ImportedServer struct {
	SourceKind       string            `json:"sourceKind,omitempty"`
	SourceKey        string            `json:"sourceKey,omitempty"`
	SourceConfigPath string            `json:"sourceConfigPath,omitempty"`
	Name             string            `json:"name"`
	Transport        string            `json:"transport"` // "stdio" or "http"
	Command          string            `json:"command,omitempty"`
	Args             []string          `json:"args,omitempty"`
	Env              map[string]string `json:"env,omitempty"`
	Endpoint         string            `json:"endpoint,omitempty"`
}

// detector reads a config file and returns discovered servers
type detector struct {
	kind   string
	name   string
	path   func() string
	detect func(path string) ([]ImportedServer, error)
}

var detectors = []detector{
	{kind: "claude_code", name: "Claude Code", path: claudeConfigPath, detect: detectClaude},
	{kind: "claude_desktop", name: "Claude Desktop", path: claudeDesktopConfigPath, detect: detectClaude},
	{kind: "codex", name: "Codex", path: codexConfigPath, detect: detectCodex},
	{kind: "gemini", name: "Gemini", path: geminiConfigPath, detect: detectGemini},
	{kind: "opencode", name: "OpenCode", path: openCodeConfigPath, detect: detectOpenCode},
}

// DetectAll probes all known MCP config sources and returns their status
func DetectAll() []Source {
	var sources []Source
	for _, d := range detectors {
		path := d.path()
		src := Source{
			Kind:       d.kind,
			SourceKey:  sourceKeyFor(d.kind, path),
			Name:       d.name,
			ConfigPath: path,
		}

		servers, err := d.detect(path)
		if err != nil {
			// File doesn't exist = not available (no error)
			if isNotExist(err) {
				sources = append(sources, src)
				continue
			}
			src.Error = err.Error()
			sources = append(sources, src)
			continue
		}

		for i := range servers {
			servers[i].SourceKind = d.kind
			servers[i].SourceKey = src.SourceKey
			servers[i].SourceConfigPath = path
		}
		src.Available = true
		src.Servers = servers
		sources = append(sources, src)
	}
	return sources
}

// ToServerConfigs converts imported servers to relay config format
func ToServerConfigs(servers []ImportedServer) []config.ServerConfig {
	var configs []config.ServerConfig
	for _, s := range servers {
		sc := config.ServerConfig{
			SyncSourceKey:  s.SourceKey,
			ManagementMode: "imported",
			Name:           s.Name,
			Transport:      s.Transport,
			Command:        s.Command,
			Args:           s.Args,
			Env:            s.Env,
			Endpoint:       s.Endpoint,
		}
		if sc.Transport == "" {
			sc.Transport = "stdio"
		}
		configs = append(configs, sc)
	}
	return configs
}

func isNotExist(err error) bool {
	return errors.Is(err, os.ErrNotExist)
}

func sourceKeyFor(kind, path string) string {
	if path == "" {
		return kind
	}
	return kind + ":" + path
}
