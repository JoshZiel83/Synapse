package commandline

import "time"

type Config struct {
	Name                     string
	InstanceID               string
	Enabled                  bool
	AllowServerAuthorization bool
	DefaultCWD               string
	MaxTimeout               time.Duration
}
