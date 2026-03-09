package importer

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// openCodeConfig represents ~/.config/opencode/opencode.json structure
type openCodeConfig struct {
	MCP map[string]openCodeServer `json:"mcp"`
}

type openCodeServer struct {
	Type        string            `json:"type"`    // "local" → stdio, "remote" → http
	Command     []string          `json:"command"` // first element = binary, rest = args
	Environment map[string]string `json:"environment"`
	URL         string            `json:"url"`
}

func openCodeConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "opencode", "opencode.json")
}

func detectOpenCode(path string) ([]ImportedServer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg openCodeConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}

	var servers []ImportedServer
	for name, srv := range cfg.MCP {
		s := ImportedServer{Name: name}

		switch srv.Type {
		case "remote":
			s.Transport = "http"
			s.Endpoint = srv.URL
		default: // "local" or unset → stdio
			s.Transport = "stdio"
			if len(srv.Command) > 0 {
				s.Command = srv.Command[0]
				if len(srv.Command) > 1 {
					s.Args = srv.Command[1:]
				}
			}
			s.Env = srv.Environment
		}

		servers = append(servers, s)
	}

	return servers, nil
}
