package importer

import (
	"errors"
	"os"
	"strings"
	"time"

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
			SyncSourceKey: s.SourceKey,
			Name:          s.Name,
			Transport:     s.Transport,
			Command:       s.Command,
			Args:          s.Args,
			Env:           s.Env,
			Endpoint:      s.Endpoint,
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

func SyncSourceStatus(available bool, detectErr string) string {
	if available {
		return "idle"
	}
	if detectErr != "" {
		return "error"
	}
	return "disabled"
}

// ReconcileConfig applies one-way follow sync for linked servers and refreshes
// sync source metadata/status based on the latest detected external sources.
func ReconcileConfig(cfg *config.Config, sources []Source) bool {
	if cfg == nil {
		return false
	}

	bySourceKey := make(map[string]Source, len(sources))
	for _, source := range sources {
		bySourceKey[source.SourceKey] = source
	}

	changed := false
	now := time.Now().UTC().Format(time.RFC3339)

	for i := range cfg.SyncSources {
		syncSource := &cfg.SyncSources[i]
		normalizedMode := config.NormalizeSyncMode(syncSource.SyncMode)
		if syncSource.SyncMode != normalizedMode {
			syncSource.SyncMode = normalizedMode
			changed = true
		}

		detected, found := bySourceKey[syncSource.SourceKey]
		status := SyncSourceStatus(false, "")
		lastError := ""
		if found {
			status = SyncSourceStatus(detected.Available, detected.Error)
			lastError = detected.Error

			if syncSource.SourceKind != detected.Kind {
				syncSource.SourceKind = detected.Kind
				changed = true
			}
			if syncSource.ConfigPath != detected.ConfigPath {
				syncSource.ConfigPath = detected.ConfigPath
				changed = true
			}

			metadata := syncSource.Metadata
			if metadata == nil {
				metadata = map[string]interface{}{}
			}
			if current, ok := metadata["displayName"].(string); !ok || current != detected.Name {
				metadata["displayName"] = detected.Name
				changed = true
			}
			if current, ok := metadata["detectedServerCount"].(int); !ok || current != len(detected.Servers) {
				metadata["detectedServerCount"] = len(detected.Servers)
				changed = true
			}
			syncSource.Metadata = metadata
		}

		if syncSource.Status != status {
			syncSource.Status = status
			changed = true
		}
		if syncSource.LastError != lastError {
			syncSource.LastError = lastError
			changed = true
		}

		if !found || !detected.Available || syncSource.SyncMode != config.SyncModeFollow {
			continue
		}

		detectedByName := make(map[string]ImportedServer, len(detected.Servers))
		for _, server := range detected.Servers {
			detectedByName[strings.TrimSpace(server.Name)] = server
		}

		sourceUpdated := false
		for j := range cfg.Servers {
			server := &cfg.Servers[j]
			if strings.TrimSpace(server.SyncSourceKey) != syncSource.SourceKey || server.Transport == "builtin" {
				continue
			}

			next, ok := detectedByName[strings.TrimSpace(server.Name)]
			if !ok {
				continue
			}

			if reconcileServerConfig(server, next) {
				changed = true
				sourceUpdated = true
			}
		}

		if sourceUpdated && syncSource.LastSyncedAt != now {
			syncSource.LastSyncedAt = now
			changed = true
		}
	}

	return changed
}

func reconcileServerConfig(server *config.ServerConfig, next ImportedServer) bool {
	if server == nil {
		return false
	}

	changed := false
	transport := next.Transport
	if transport == "" {
		transport = "stdio"
	}
	if server.Transport != transport {
		server.Transport = transport
		changed = true
	}
	if server.Command != next.Command {
		server.Command = next.Command
		changed = true
	}
	if !stringSlicesEqual(server.Args, next.Args) {
		server.Args = append([]string(nil), next.Args...)
		changed = true
	}
	if !stringMapsEqual(server.Env, next.Env) {
		server.Env = cloneStringMap(next.Env)
		changed = true
	}
	if server.Endpoint != next.Endpoint {
		server.Endpoint = next.Endpoint
		changed = true
	}

	metadata := server.Metadata
	if metadata == nil {
		metadata = map[string]interface{}{}
	}
	if current, ok := metadata["sourceKind"].(string); !ok || current != next.SourceKind {
		metadata["sourceKind"] = next.SourceKind
		server.Metadata = metadata
		changed = true
	}

	return changed
}

func stringSlicesEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func stringMapsEqual(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}

func cloneStringMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return map[string]string{}
	}
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}
