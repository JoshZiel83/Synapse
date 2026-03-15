package main

import (
	"embed"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	windowsoptions "github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

var Version = "dev"

func main() {
	app := NewApp()
	startHidden := hasLaunchAtLoginArg(os.Args[1:])

	err := wails.Run(&options.App{
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
	if err != nil {
		println("Error:", err.Error())
	}
}
