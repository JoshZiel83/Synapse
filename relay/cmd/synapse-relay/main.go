package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/cloud"
	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/importer"
	"github.com/PekingSpades/Synapse/relay/internal/relay"
)

var Version = "dev"

func main() {
	configPath := flag.String("c", "", "path to config file")
	showVersion := flag.Bool("version", false, "show version")
	importMode := flag.Bool("import", false, "import MCP configs from other tools")
	pairMode := flag.Bool("pair", false, "pair this relay client with a Synapse server")
	serverBaseURL := flag.String("server-base-url", "", "relay server base URL for --pair")
	pairingCode := flag.String("pairing-code", "", "relay pairing code for --pair")
	displayName := flag.String("display-name", "", "relay display name for --pair")
	flag.Parse()

	if *showVersion {
		fmt.Printf("synapse-relay %s\n", Version)
		os.Exit(0)
	}

	// Resolve config path
	cfgPath := config.Resolve(*configPath)

	// Import mode
	if *importMode {
		runImport(cfgPath)
		return
	}
	if *pairMode {
		runPair(cfgPath, *serverBaseURL, *pairingCode, *displayName)
		return
	}

	// Normal run mode — config is required
	if cfgPath == "" {
		log.Fatalf("No config file found. Use -c <path>, run with --pair to bind a relay device, or run with --import to add MCP servers.")
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}
	if errs := config.Validate(cfg); len(errs) > 0 {
		log.Fatalf("Invalid relay config: %s", errs[0])
	}

	setupLogging(cfg.LogLevel)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// Handle signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		log.Printf("Received signal %v, shutting down...", sig)
		cancel()
	}()

	// Create and start engine
	engine := relay.New(cfg)

	// Log events to stdout
	engine.OnEvent(func(evt relay.Event) {
		log.Printf("[%s] %s", evt.Type, evt.Message)
	})

	if err := engine.Start(ctx); err != nil {
		log.Fatalf("Failed to start engine: %v", err)
	}

	// Wait for engine to stop
	engine.Wait()

	if engine.LastError() != nil {
		log.Fatalf("Engine error: %v", engine.LastError())
	}

	log.Println("Shutdown complete")
}

func setupLogging(level string) {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
	if level == "debug" {
		log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds | log.Lshortfile)
	}
}

func runImport(cfgPath string) {
	fmt.Println("Scanning for MCP configurations...")
	fmt.Println()

	sources := importer.DetectAll()
	anyFound := false
	for _, src := range sources {
		if src.Available {
			fmt.Printf("  \033[32m✓\033[0m %-12s %s (%d servers found)\n", src.Name, src.ConfigPath, len(src.Servers))
			anyFound = true
		} else if src.Error != "" {
			fmt.Printf("  \033[31m✗\033[0m %-12s %s (error: %s)\n", src.Name, src.ConfigPath, src.Error)
		} else {
			fmt.Printf("  \033[90m✗\033[0m %-12s %s (not found)\n", src.Name, src.ConfigPath)
		}
	}
	fmt.Println()

	if !anyFound {
		fmt.Println("No MCP configurations found from any supported tool.")
		return
	}

	// Collect all available servers
	var allServers []importedEntry
	for _, src := range sources {
		for _, srv := range src.Servers {
			allServers = append(allServers, importedEntry{source: src.Name, server: srv})
		}
	}

	if len(allServers) == 0 {
		fmt.Println("No MCP servers found in detected configurations.")
		return
	}

	fmt.Println("Available servers:")
	for i, entry := range allServers {
		fmt.Printf("  [%d] ✓ %s (%s, %s)\n", i+1, entry.server.Name, entry.source, entry.server.Transport)
	}
	fmt.Println()

	// Prompt user
	reader := bufio.NewReader(os.Stdin)
	fmt.Print("Enter numbers to import (comma-separated, or 'all'): ")
	input, _ := reader.ReadString('\n')
	input = strings.TrimSpace(input)

	if input == "" {
		fmt.Println("No servers selected.")
		return
	}

	var selected []importer.ImportedServer
	if strings.ToLower(input) == "all" {
		for _, entry := range allServers {
			selected = append(selected, entry.server)
		}
	} else {
		parts := strings.Split(input, ",")
		for _, p := range parts {
			p = strings.TrimSpace(p)
			var idx int
			if _, err := fmt.Sscanf(p, "%d", &idx); err != nil || idx < 1 || idx > len(allServers) {
				fmt.Printf("Invalid selection: %s\n", p)
				return
			}
			selected = append(selected, allServers[idx-1].server)
		}
	}

	if len(selected) == 0 {
		fmt.Println("No servers selected.")
		return
	}

	// Load or create config
	if cfgPath == "" {
		cfgPath = config.DefaultPath()
	}

	var cfg *config.Config
	if existing, err := config.LoadOrDefault(cfgPath); err == nil {
		cfg = existing
	} else {
		cfg = &config.Config{LogLevel: "info"}
	}

	// Merge imported servers (skip duplicates by name)
	existingNames := make(map[string]bool)
	for _, s := range cfg.Servers {
		existingNames[s.Name] = true
	}

	serverConfigs := importer.ToServerConfigs(selected)
	added := 0
	for _, sc := range serverConfigs {
		if existingNames[sc.Name] {
			fmt.Printf("  Skipping %s (already in config)\n", sc.Name)
			continue
		}
		cfg.Servers = append(cfg.Servers, sc)
		added++
	}

	for _, srv := range selected {
		if strings.TrimSpace(srv.SourceKey) == "" {
			continue
		}
		syncMode := "import_only"
		for i := range cfg.SyncSources {
			if cfg.SyncSources[i].SourceKey == srv.SourceKey && strings.TrimSpace(cfg.SyncSources[i].SyncMode) != "" {
				syncMode = cfg.SyncSources[i].SyncMode
				break
			}
		}
		upsertSyncSource(cfg, config.SyncSourceConfig{
			SourceKind: srv.SourceKind,
			SourceKey:  srv.SourceKey,
			ConfigPath: srv.SourceConfigPath,
			SyncMode:   syncMode,
			Status:     "idle",
		})
	}

	if added == 0 {
		fmt.Println("All selected servers already exist in config.")
		return
	}

	// Save config
	if err := config.EnsureDir(); err != nil {
		log.Fatalf("Failed to create config dir: %v", err)
	}
	if err := config.Save(cfgPath, cfg); err != nil {
		log.Fatalf("Failed to save config: %v", err)
	}

	fmt.Printf("Config saved to %s (%d servers added)\n", cfgPath, added)
	if cfg.Relay.DeviceID == "" {
		fmt.Println("Relay pairing is not configured yet. Run `synapse-relay --pair` before starting the relay.")
	}
}

func runPair(cfgPath, serverBaseURL, pairingCode, displayName string) {
	reader := bufio.NewReader(os.Stdin)
	defaultDisplayName := cloud.DefaultRelayDisplayName()

	if strings.TrimSpace(serverBaseURL) == "" {
		fmt.Print("Enter relay server base URL: ")
		value, _ := reader.ReadString('\n')
		serverBaseURL = strings.TrimSpace(value)
	}
	if strings.TrimSpace(pairingCode) == "" {
		fmt.Print("Enter relay pairing code: ")
		value, _ := reader.ReadString('\n')
		pairingCode = strings.TrimSpace(value)
	}
	if strings.TrimSpace(displayName) == "" {
		fmt.Printf("Enter display name (optional, default %s): ", defaultDisplayName)
		value, _ := reader.ReadString('\n')
		displayName = strings.TrimSpace(value)
	}

	if cfgPath == "" {
		cfgPath = config.DefaultPath()
	}

	cfg, err := config.LoadOrDefault(cfgPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	cfg.Relay.ServerBaseURL = strings.TrimSpace(serverBaseURL)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	nextRelay, result, err := cloud.ClaimPairing(ctx, cfg.Relay, pairingCode, displayName)
	if err != nil {
		log.Fatalf("Failed to claim pairing: %v", err)
	}
	cfg.Relay = *nextRelay

	if err := config.EnsureDir(); err != nil {
		log.Fatalf("Failed to create config dir: %v", err)
	}
	if err := config.Save(cfgPath, cfg); err != nil {
		log.Fatalf("Failed to save config: %v", err)
	}

	fmt.Printf("Relay paired: %s (%s)\n", result.DeviceID, result.DisplayName)
	fmt.Printf("Config saved to %s\n", cfgPath)
}

func upsertSyncSource(cfg *config.Config, next config.SyncSourceConfig) {
	for i := range cfg.SyncSources {
		if cfg.SyncSources[i].SourceKey == next.SourceKey {
			cfg.SyncSources[i] = next
			return
		}
	}
	cfg.SyncSources = append(cfg.SyncSources, next)
}

type importedEntry struct {
	source string
	server importer.ImportedServer
}
