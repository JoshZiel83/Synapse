//go:build relay_fuse

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
	"github.com/PekingSpades/Synapse/relay/internal/vfs"
	"github.com/PekingSpades/Synapse/relay/internal/vfsmount"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "doctor":
		runDoctor()
	case "unmount":
		runUnmount(os.Args[2:])
	case "mount":
		runMount(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Println("Usage:")
	fmt.Println("  synapse-relay-mount doctor")
	fmt.Println("  synapse-relay-mount mount [-c config.yaml] <target>")
	fmt.Println("  synapse-relay-mount unmount <target>")
}

func runDoctor() {
	result := vfsmount.Doctor()
	encoded, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(encoded))
}

func runUnmount(args []string) {
	flags := flag.NewFlagSet("unmount", flag.ExitOnError)
	_ = flags.Parse(args)
	if flags.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "unmount requires a target")
		os.Exit(2)
	}
	if err := vfsmount.UnmountTarget(flags.Arg(0)); err != nil {
		fmt.Fprintf(os.Stderr, "unmount failed: %v\n", err)
		os.Exit(1)
	}
}

func runMount(args []string) {
	flags := flag.NewFlagSet("mount", flag.ExitOnError)
	configPath := flags.String("c", "", "path to config file")
	_ = flags.Parse(args)
	if flags.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "mount requires a target")
		os.Exit(2)
	}

	cfgPath := config.Resolve(*configPath)
	if cfgPath == "" {
		fmt.Fprintln(os.Stderr, "No config file found. Use -c <path>.")
		os.Exit(1)
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		os.Exit(1)
	}

	paths := relaypaths.ResolveStandaloneProfile(relaypaths.DefaultHostPaths(relaypaths.HostCLI))
	relaypaths.SetCurrent(paths)

	service, err := vfs.New(paths, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "init relay vfs: %v\n", err)
		os.Exit(1)
	}

	startCtx, startCancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer startCancel()
	if err := service.Start(startCtx); err != nil {
		fmt.Fprintf(os.Stderr, "start relay vfs: %v\n", err)
		os.Exit(1)
	}
	defer service.Close()

	mountCtx, mountCancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGINT, syscall.SIGTERM)
	defer mountCancel()
	if err := vfsmount.Mount(mountCtx, service, flags.Arg(0), nil); err != nil && err != context.Canceled {
		fmt.Fprintf(os.Stderr, "mount failed: %v\n", err)
		os.Exit(1)
	}
}
