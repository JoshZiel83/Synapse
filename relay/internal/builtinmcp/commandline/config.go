package commandline

import "time"

type Config struct {
	Name       string
	InstanceID string
	DefaultCWD string
	MaxTimeout time.Duration
}
