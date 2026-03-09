package importer

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// geminiConfig represents ~/.gemini/settings.json structure
type geminiConfig struct {
	MCPServers map[string]geminiServer `json:"mcpServers"`
}

type geminiServer struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	URL     string            `json:"url"`
	HTTPUrl string            `json:"httpUrl"`
}

func geminiConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".gemini", "settings.json")
}

func detectGemini(path string) ([]ImportedServer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg geminiConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}

	var servers []ImportedServer
	for name, srv := range cfg.MCPServers {
		s := ImportedServer{Name: name}

		// Infer type from fields: command → stdio, url/httpUrl → http
		endpoint := srv.URL
		if endpoint == "" {
			endpoint = srv.HTTPUrl
		}

		if endpoint != "" {
			s.Transport = "http"
			s.Endpoint = endpoint
		} else {
			s.Transport = "stdio"
			s.Command = srv.Command
			s.Args = srv.Args
			s.Env = srv.Env
		}

		servers = append(servers, s)
	}

	return servers, nil
}
