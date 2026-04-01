package chrome

type Config struct {
	StableKey                string
	Name                     string
	InstanceID               string
	Enabled                  bool
	TrustRemoteAuthorization bool
	ConnectionMode           string
	Channel                  string
	ExecutablePath           string
	UserDataDir              string
	BrowserURL               string
	WSEndpoint               string
	WSHeaders                map[string]string
	Headless                 bool
	Isolated                 bool
	AcceptInsecureCerts      bool
	LogFile                  string
	ChromeArgs               []string
	IgnoreDefaultChromeArgs  []string
	Slim                     bool
	UsageStatistics          bool
	PerformanceCrux          bool
	LogsDir                  string
}
