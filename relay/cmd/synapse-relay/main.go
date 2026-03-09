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

	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/importer"
	"github.com/PekingSpades/Synapse/relay/internal/relay"
)

var Version = "dev"

func main() {
	configPath := flag.String("c", "", "path to config file")
	showVersion := flag.Bool("version", false, "show version")
	importMode := flag.Bool("import", false, "import MCP configs from other tools")
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

	// Normal run mode — config is required
	if cfgPath == "" {
		log.Fatalf("No config file found. Use -c <path>, create ./config.yaml, or run with --import to set up.")
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	setupLogging(cfg.LogLevel)

	ctx, cancel := context.WithCancel(context.Background())
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

	if added == 0 {
		fmt.Println("All selected servers already exist in config.")
		return
	}

	// Prompt for endpoint/token if not set
	if cfg.Endpoint == "" {
		fmt.Print("Enter relay endpoint URL: ")
		endpoint, _ := reader.ReadString('\n')
		cfg.Endpoint = strings.TrimSpace(endpoint)
	}
	if cfg.Token == "" {
		fmt.Print("Enter auth token: ")
		token, _ := reader.ReadString('\n')
		cfg.Token = strings.TrimSpace(token)
	}

	// Save config
	if err := config.EnsureDir(); err != nil {
		log.Fatalf("Failed to create config dir: %v", err)
	}
	if err := config.Save(cfgPath, cfg); err != nil {
		log.Fatalf("Failed to save config: %v", err)
	}

	fmt.Printf("Config saved to %s (%d servers added)\n", cfgPath, added)
}

type importedEntry struct {
	source string
	server importer.ImportedServer
}
