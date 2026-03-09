package importer

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// claudeConfig represents ~/.claude.json structure
type claudeConfig struct {
	MCPServers map[string]claudeServer `json:"mcpServers"`
}

type claudeServer struct {
	Type    string            `json:"type"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	URL     string            `json:"url"`
}

func claudeConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude.json")
}

func detectClaude(path string) ([]ImportedServer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg claudeConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}

	var servers []ImportedServer
	for name, srv := range cfg.MCPServers {
		s := ImportedServer{Name: name}

		srvType := srv.Type
		if srvType == "" {
			// Default: if url is set, it's http; otherwise stdio
			if srv.URL != "" {
				srvType = "http"
			} else {
				srvType = "stdio"
			}
		}

		switch srvType {
		case "stdio":
			s.Transport = "stdio"
			s.Command = srv.Command
			s.Args = srv.Args
			s.Env = srv.Env
		case "http", "sse":
			s.Transport = "http"
			s.Endpoint = srv.URL
		default:
			s.Transport = "stdio"
			s.Command = srv.Command
			s.Args = srv.Args
			s.Env = srv.Env
		}

		servers = append(servers, s)
	}

	return servers, nil
}
