package main

import (
	"embed"
	"log"
	"os"
	"runtime/debug"

	"github.com/PekingSpades/Synapse/relay/internal/desktopdiag"
	"github.com/PekingSpades/Synapse/relay/internal/relayagentcmd"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	windowsoptions "github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

var Version = "dev"

func main() {
	if args, ok := relayAgentArgs(os.Args[1:]); ok {
		os.Exit(relayagentcmd.Run(Version, args))
	}

	relaypaths.SetCurrent(newStandalonePaths())

	logging, err := desktopdiag.SetupLogging()
	if err != nil {
		println("Error:", err.Error())
	}
	if logging != nil {
		defer logging.Close()
	}

	diagManager, crashReport, err := desktopdiag.Start(Version)
	if err != nil {
		log.Printf("Warning: failed to initialise desktop diagnostics: %v", err)
	}

	defer func() {
		if recovered := recover(); recovered != nil {
			if diagManager != nil {
				_ = diagManager.RecordPanic("main", recovered, debug.Stack())
			} else {
				log.Printf("Fatal desktop panic recovered=%v\n%s", recovered, string(debug.Stack()))
			}
			if logging != nil {
				_ = logging.Close()
			}
			os.Exit(1)
		}
	}()

	app := NewApp(diagManager, crashReport)
	startHidden := hasLaunchAtLoginArg(os.Args[1:])

	err = wails.Run(&options.App{
		Title:         "Synapse Relay",
		Width:         1120,
		Height:        720,
		MinWidth:      1120,
		MinHeight:     720,
		MaxWidth:      1120,
		MaxHeight:     720,
		DisableResize: true,
		StartHidden:   startHidden,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		Windows: &windowsoptions.Options{
			Theme: windowsoptions.SystemDefault,
		},
		OnStartup:     app.startup,
		OnDomReady:    app.domReady,
		OnShutdown:    app.shutdown,
		OnBeforeClose: app.beforeClose,
		Bind: []interface{}{
			app,
		},
	})
	if diagManager != nil {
		_ = diagManager.MarkClean("run_returned")
	}
	if err != nil {
		log.Printf("Error: %v", err)
	}
}

func relayAgentArgs(args []string) ([]string, bool) {
	for index, arg := range args {
		if arg != "--relay-agent" {
			continue
		}
		filtered := make([]string, 0, len(args)-1)
		filtered = append(filtered, args[:index]...)
		filtered = append(filtered, args[index+1:]...)
		return filtered, true
	}
	return nil, false
}
