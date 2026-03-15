package chrome

type Config struct {
	Name                    string
	InstanceID              string
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
}
