package chrome

import "github.com/PekingSpades/Synapse/relay/internal/runtimeauth"

type Config struct {
	StableKey               string
	Name                    string
	InstanceID              string
	Enabled                 bool
	ConnectionMode          string
	Channel                 string
	ExecutablePath          string
	UserDataDir             string
	BrowserURL              string
	WSEndpoint              string
	WSHeaders               map[string]string
	Headless                bool
	Isolated                bool
	AcceptInsecureCerts     bool
	LogFile                 string
	ChromeArgs              []string
	IgnoreDefaultChromeArgs []string
	Slim                    bool
	UsageStatistics         bool
	PerformanceCrux         bool
	AuthStore               *runtimeauth.Store
	LogsDir                 string
}
