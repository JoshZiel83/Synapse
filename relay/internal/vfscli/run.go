package vfscli

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
	"github.com/PekingSpades/Synapse/relay/internal/vfs"
)

func Run(args []string) int {
	flags := flag.NewFlagSet("synapse-relay vfs", flag.ContinueOnError)
	configPath := flags.String("c", "", "path to config file")
	jsonOutput := flags.Bool("json", false, "render list/stat output as JSON")
	if err := flags.Parse(args); err != nil {
		return 2
	}

	rest := flags.Args()
	if len(rest) == 0 {
		printUsage()
		return 2
	}

	cfgPath := config.Resolve(*configPath)
	if cfgPath == "" {
		fmt.Fprintln(os.Stderr, "No config file found. Use -c <path>.")
		return 1
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		return 1
	}

	paths := relaypaths.ResolveStandaloneProfile(relaypaths.DefaultHostPaths(relaypaths.HostCLI))
	relaypaths.SetCurrent(paths)

	service, err := vfs.New(paths, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to initialize relay vfs: %v\n", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if err := service.Start(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start relay vfs: %v\n", err)
		return 1
	}
	defer service.Close()

	switch rest[0] {
	case "ls":
		target := "/"
		if len(rest) > 1 {
			target = rest[1]
		}
		return runLS(service, target, *jsonOutput)
	case "stat":
		if len(rest) < 2 {
			fmt.Fprintln(os.Stderr, "stat requires a path")
			return 2
		}
		return runStat(service, rest[1], *jsonOutput)
	case "cat", "read":
		if len(rest) < 2 {
			fmt.Fprintln(os.Stderr, "cat requires a path")
			return 2
		}
		return runCat(service, rest[1])
	case "write":
		if len(rest) < 2 {
			fmt.Fprintln(os.Stderr, "write requires a path")
			return 2
		}
		return runWrite(service, rest[1])
	case "watch":
		return runWatch(service, rest[1:])
	default:
		fmt.Fprintf(os.Stderr, "Unknown vfs subcommand %q\n", rest[0])
		printUsage()
		return 2
	}
}

func printUsage() {
	fmt.Println("Usage:")
	fmt.Println("  synapse-relay vfs [-c config.yaml] ls [path]")
	fmt.Println("  synapse-relay vfs [-c config.yaml] stat <path>")
	fmt.Println("  synapse-relay vfs [-c config.yaml] cat <path>")
	fmt.Println("  synapse-relay vfs [-c config.yaml] write <path> < payload.json")
	fmt.Println("  synapse-relay vfs [-c config.yaml] watch [-interval 1s] <path>")
	fmt.Println()
	fmt.Println("Paths may use either absolute form or relayfs:// URIs.")
}

func runLS(service *vfs.Service, target string, jsonOutput bool) int {
	entries, err := service.List(target)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ls %s: %v\n", target, err)
		return 1
	}
	if jsonOutput {
		return printJSON(entries)
	}
	for _, entry := range entries {
		kind := "f"
		if entry.Kind == vfs.NodeKindDirectory {
			kind = "d"
		}
		mode := "ro"
		if entry.Writable {
			mode = "rw"
		}
		displayPath := entry.Path
		if strings.TrimSpace(displayPath) == "" {
			displayPath = path.Join(strings.TrimSuffix(target, "/"), entry.Name)
		}
		fmt.Printf("%s %-2s %s\n", kind, mode, displayPath)
	}
	return 0
}

func runStat(service *vfs.Service, target string, jsonOutput bool) int {
	entry, err := service.Stat(target)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stat %s: %v\n", target, err)
		return 1
	}
	if jsonOutput {
		return printJSON(entry)
	}
	fmt.Printf("path: %s\n", entry.Path)
	fmt.Printf("name: %s\n", entry.Name)
	fmt.Printf("kind: %s\n", entry.Kind)
	fmt.Printf("mime: %s\n", entry.MimeType)
	fmt.Printf("writable: %t\n", entry.Writable)
	return 0
}

func runCat(service *vfs.Service, target string) int {
	result, err := service.Read(target)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cat %s: %v\n", target, err)
		return 1
	}
	if _, err := os.Stdout.Write(result.Data); err != nil {
		fmt.Fprintf(os.Stderr, "write stdout: %v\n", err)
		return 1
	}
	return 0
}

func runWrite(service *vfs.Service, target string) int {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read stdin: %v\n", err)
		return 1
	}
	result, err := service.Write(target, data)
	if err != nil {
		fmt.Fprintf(os.Stderr, "write %s: %v\n", target, err)
		return 1
	}
	if len(result.Data) > 0 {
		if _, err := os.Stdout.Write(result.Data); err != nil {
			fmt.Fprintf(os.Stderr, "write stdout: %v\n", err)
			return 1
		}
		if len(result.Data) == 0 || result.Data[len(result.Data)-1] != '\n' {
			fmt.Println()
		}
	}
	return 0
}

func runWatch(service *vfs.Service, args []string) int {
	flags := flag.NewFlagSet("watch", flag.ContinueOnError)
	interval := flags.Duration("interval", time.Second, "poll interval")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "watch requires a path")
		return 2
	}
	if *interval <= 0 {
		fmt.Fprintln(os.Stderr, "watch interval must be greater than zero")
		return 2
	}

	target := flags.Arg(0)
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	ticker := time.NewTicker(*interval)
	defer ticker.Stop()

	var lastData []byte
	lastMimeType := ""
	lastError := ""
	first := true
	for {
		result, err := service.Read(target)
		if err != nil {
			errText := err.Error()
			if first || errText != lastError {
				if emitErr := emitWatchEvent(watchEvent{
					Time:  time.Now().Format(time.RFC3339Nano),
					Path:  target,
					Error: errText,
				}); emitErr != nil {
					fmt.Fprintf(os.Stderr, "watch %s: %v\n", target, emitErr)
					return 1
				}
				lastError = errText
				lastData = nil
				lastMimeType = ""
			}
		} else if first || lastError != "" || lastMimeType != result.MimeType || !bytes.Equal(lastData, result.Data) {
			if emitErr := emitWatchEvent(newWatchEvent(target, result)); emitErr != nil {
				fmt.Fprintf(os.Stderr, "watch %s: %v\n", target, emitErr)
				return 1
			}
			lastError = ""
			lastMimeType = result.MimeType
			lastData = append(lastData[:0], result.Data...)
		}
		first = false

		select {
		case <-ctx.Done():
			return 0
		case <-ticker.C:
		}
	}
}

type watchEvent struct {
	Time       string `json:"time"`
	Path       string `json:"path"`
	MimeType   string `json:"mimeType,omitempty"`
	Size       int    `json:"size,omitempty"`
	Encoding   string `json:"encoding,omitempty"`
	Text       string `json:"text,omitempty"`
	DataBase64 string `json:"dataBase64,omitempty"`
	Error      string `json:"error,omitempty"`
}

func newWatchEvent(target string, result vfs.ReadResult) watchEvent {
	event := watchEvent{
		Time:     time.Now().Format(time.RFC3339Nano),
		Path:     target,
		MimeType: result.MimeType,
		Size:     len(result.Data),
	}
	if watchTreatAsText(result.MimeType, result.Data) {
		event.Encoding = "utf-8"
		event.Text = string(result.Data)
		return event
	}
	event.Encoding = "base64"
	event.DataBase64 = base64.StdEncoding.EncodeToString(result.Data)
	return event
}

func emitWatchEvent(event watchEvent) error {
	encoded, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err := os.Stdout.Write(append(encoded, '\n')); err != nil {
		return err
	}
	return nil
}

func watchTreatAsText(mimeType string, data []byte) bool {
	if strings.HasPrefix(mimeType, "text/") || strings.HasSuffix(mimeType, "/json") || strings.HasSuffix(mimeType, "+json") {
		return utf8.Valid(data)
	}
	return utf8.Valid(data) && !bytes.ContainsRune(data, '\x00')
}

func printJSON(value interface{}) int {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode json: %v\n", err)
		return 1
	}
	fmt.Println(string(encoded))
	return 0
}
