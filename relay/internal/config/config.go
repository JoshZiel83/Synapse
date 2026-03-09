package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Endpoint string         `yaml:"endpoint"`
	Token    string         `yaml:"token"`
	LogLevel string         `yaml:"log_level"`
	Servers  []ServerConfig `yaml:"servers"`
}

type ServerConfig struct {
	Name      string            `yaml:"name"`
	Transport string            `yaml:"transport"` // "stdio" or "http"
	Command   string            `yaml:"command"`    // for stdio
	Args      []string          `yaml:"args"`       // for stdio
	Env       map[string]string `yaml:"env"`        // for stdio
	Endpoint  string            `yaml:"endpoint"`   // for http
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	if cfg.Endpoint == "" {
		return nil, fmt.Errorf("endpoint is required")
	}
	if cfg.Token == "" {
		return nil, fmt.Errorf("token is required")
	}
	if len(cfg.Servers) == 0 {
		return nil, fmt.Errorf("at least one server is required")
	}
	if cfg.LogLevel == "" {
		cfg.LogLevel = "info"
	}

	for i, s := range cfg.Servers {
		if s.Name == "" {
			return nil, fmt.Errorf("server[%d]: name is required", i)
		}
		if s.Transport == "" {
			cfg.Servers[i].Transport = "stdio"
		}
		switch s.Transport {
		case "stdio":
			if s.Command == "" {
				return nil, fmt.Errorf("server[%d] (%s): command is required for stdio transport", i, s.Name)
			}
		case "http":
			if s.Endpoint == "" {
				return nil, fmt.Errorf("server[%d] (%s): endpoint is required for http transport", i, s.Name)
			}
		default:
			return nil, fmt.Errorf("server[%d] (%s): unsupported transport %q", i, s.Name, s.Transport)
		}
	}

	return &cfg, nil
}
