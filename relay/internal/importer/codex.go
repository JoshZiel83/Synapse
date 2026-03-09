package importer

import (
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// codexConfig represents ~/.codex/config.toml structure
type codexConfig struct {
	MCPServers map[string]codexServer `toml:"mcp_servers"`
}

type codexServer struct {
	Type    string            `toml:"type"`
	Command string            `toml:"command"`
	Args    []string          `toml:"args"`
	Env     map[string]string `toml:"env"`
	URL     string            `toml:"url"`
}

func codexConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "config.toml")
}

func detectCodex(path string) ([]ImportedServer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg codexConfig
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}

	var servers []ImportedServer
	for name, srv := range cfg.MCPServers {
		s := ImportedServer{Name: name}

		srvType := srv.Type
		if srvType == "" {
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
