package config

import (
	"fmt"
	"os"
	"path/filepath"

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

// DefaultDir returns the default config directory (~/.synapse-relay/)
func DefaultDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".synapse-relay"
	}
	return filepath.Join(home, ".synapse-relay")
}

// DefaultPath returns the default config file path (~/.synapse-relay/config.yaml)
func DefaultPath() string {
	return filepath.Join(DefaultDir(), "config.yaml")
}

// EnsureDir creates the ~/.synapse-relay/ directory if it doesn't exist
func EnsureDir() error {
	return os.MkdirAll(DefaultDir(), 0755)
}

// Resolve finds the config file path using cascade:
// explicit flag → ./config.yaml → ~/.synapse-relay/config.yaml → empty
func Resolve(explicit string) string {
	if explicit != "" {
		return explicit
	}

	// Check working directory
	if _, err := os.Stat("config.yaml"); err == nil {
		return "config.yaml"
	}

	// Check default path
	dp := DefaultPath()
	if _, err := os.Stat(dp); err == nil {
		return dp
	}

	return ""
}

// Load reads and validates a config from a file path
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
		switch cfg.Servers[i].Transport {
		case "stdio":
			if s.Command == "" {
				return nil, fmt.Errorf("server[%d] (%s): command is required for stdio transport", i, s.Name)
			}
		case "http":
			if s.Endpoint == "" {
				return nil, fmt.Errorf("server[%d] (%s): endpoint is required for http transport", i, s.Name)
			}
		default:
			return nil, fmt.Errorf("server[%d] (%s): unsupported transport %q", i, s.Name, cfg.Servers[i].Transport)
		}
	}

	return &cfg, nil
}

// LoadOrDefault tries to load a config file; if path is empty, returns a default Config
func LoadOrDefault(path string) (*Config, error) {
	if path == "" {
		return &Config{LogLevel: "info"}, nil
	}
	return Load(path)
}

// Validate returns a list of validation errors (non-fatal, for GUI use)
func Validate(cfg *Config) []string {
	var errs []string

	if cfg.Endpoint == "" {
		errs = append(errs, "endpoint is required")
	}
	if cfg.Token == "" {
		errs = append(errs, "token is required")
	}
	if cfg.LogLevel == "" {
		cfg.LogLevel = "info"
	}

	for i, s := range cfg.Servers {
		if s.Name == "" {
			errs = append(errs, fmt.Sprintf("server[%d]: name is required", i))
			continue
		}
		transport := s.Transport
		if transport == "" {
			transport = "stdio"
		}
		switch transport {
		case "stdio":
			if s.Command == "" {
				errs = append(errs, fmt.Sprintf("server %q: command is required for stdio transport", s.Name))
			}
		case "http":
			if s.Endpoint == "" {
				errs = append(errs, fmt.Sprintf("server %q: endpoint is required for http transport", s.Name))
			}
		default:
			errs = append(errs, fmt.Sprintf("server %q: unsupported transport %q", s.Name, transport))
		}
	}

	return errs
}

// Save writes a config to a file atomically (write to .tmp, rename)
func Save(path string, cfg *Config) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create dir: %w", err)
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("write tmp: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename: %w", err)
	}

	return nil
}
