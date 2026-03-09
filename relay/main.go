package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/PekingSpades/Synapse/relay/internal/cloud"
	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/mcp"
)

var Version = "dev"

func main() {
	configPath := flag.String("c", "config.yaml", "path to config file")
	showVersion := flag.Bool("version", false, "show version")
	flag.Parse()

	if *showVersion {
		fmt.Printf("synapse-relay %s\n", Version)
		os.Exit(0)
	}

	cfg, err := config.Load(*configPath)
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

	// Start local MCP servers and discover tools
	mgr := mcp.NewManager(cfg.Servers)
	if err := mgr.InitAll(ctx); err != nil {
		log.Fatalf("Failed to initialize MCP servers: %v", err)
	}
	defer mgr.ShutdownAll()

	servers := mgr.GetServerInfo()
	log.Printf("Discovered %d MCP servers with tools", len(servers))
	for _, s := range servers {
		log.Printf("  - %s (%s): %d tools", s.Name, s.Transport, len(s.Tools))
	}

	// Connect to cloud
	client := cloud.NewClient(cfg.Endpoint, cfg.Token, mgr)
	client.SetServers(servers)

	if err := client.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("Cloud client error: %v", err)
	}

	log.Println("Shutdown complete")
}

func setupLogging(level string) {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
	if level == "debug" {
		log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds | log.Lshortfile)
	}
}
