package mcp

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/chrome"
	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/commandline"
	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/cua"
	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/filesystem"
	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
)

type builtinAdapter struct {
	inner core.Server
}

type eventEmitterAware interface {
	SetEventEmitter(func(string, string, map[string]interface{}))
}

type cuaTerminatorAware interface {
	SetCUASessionTerminator(func(string, string))
}

func newBuiltinServer(cfg config.ServerConfig) (Server, error) {
	if cfg.Builtin == nil {
		return nil, fmt.Errorf("builtin config is required")
	}
	enabled := config.ServerEnabled(cfg)

	switch cfg.Builtin.Kind {
	case "chrome":
		if cfg.Builtin.Chrome == nil {
			return nil, fmt.Errorf("builtin.chrome config is required")
		}

		paths := relaypaths.Current()
		server, err := chrome.New(chrome.Config{
			StableKey:               cfg.StableKey,
			Name:                    cfg.Name,
			InstanceID:              cfg.Builtin.InstanceID,
			Enabled:                 enabled,
			ConnectionMode:          cfg.Builtin.Chrome.ConnectionMode,
			Channel:                 cfg.Builtin.Chrome.Channel,
			ExecutablePath:          cfg.Builtin.Chrome.ExecutablePath,
			UserDataDir:             cfg.Builtin.Chrome.UserDataDir,
			BrowserURL:              cfg.Builtin.Chrome.BrowserURL,
			WSEndpoint:              cfg.Builtin.Chrome.WSEndpoint,
			WSHeaders:               cfg.Builtin.Chrome.WSHeaders,
			Headless:                cfg.Builtin.Chrome.Headless != nil && *cfg.Builtin.Chrome.Headless,
			Isolated:                cfg.Builtin.Chrome.Isolated != nil && *cfg.Builtin.Chrome.Isolated,
			AcceptInsecureCerts:     cfg.Builtin.Chrome.AcceptInsecureCerts != nil && *cfg.Builtin.Chrome.AcceptInsecureCerts,
			LogFile:                 cfg.Builtin.Chrome.LogFile,
			ChromeArgs:              cfg.Builtin.Chrome.ChromeArgs,
			IgnoreDefaultChromeArgs: cfg.Builtin.Chrome.IgnoreDefaultChromeArgs,
			Slim:                    cfg.Builtin.Chrome.Slim == nil || *cfg.Builtin.Chrome.Slim,
			UsageStatistics:         cfg.Builtin.Chrome.UsageStatistics != nil && *cfg.Builtin.Chrome.UsageStatistics,
			PerformanceCrux:         cfg.Builtin.Chrome.PerformanceCrux != nil && *cfg.Builtin.Chrome.PerformanceCrux,
			LogsDir:                 filepath.Join(paths.LogsDir, "chrome-devtools-mcp"),
		})
		if err != nil {
			return nil, err
		}
		return &builtinAdapter{inner: server}, nil
	case "cua":
		if cfg.Builtin.CUA == nil {
			return nil, fmt.Errorf("builtin.cua config is required")
		}
		server, err := cua.New(cua.Config{
			StableKey:            cfg.StableKey,
			Enabled:              enabled,
			ReadOnly:             cfg.Builtin.CUA.ReadOnly != nil && *cfg.Builtin.CUA.ReadOnly,
			RelativeCoordinate:   cfg.Builtin.CUA.RelativeCoordinate,
			ImageSize:            cfg.Builtin.CUA.ImageSize,
			RelativeSize:         cfg.Builtin.CUA.RelativeSize,
			ScrollMultiplier:     cfg.Builtin.CUA.ScrollMultiplier,
			LogDir:               cfg.Builtin.CUA.LogDir,
			StateDir:             relaypaths.Current().StateDir,
			AllowDisplayOverride: cfg.Builtin.CUA.AllowDisplayOverride == nil || *cfg.Builtin.CUA.AllowDisplayOverride,
			IncludeOverviewTool:  cfg.Builtin.CUA.IncludeOverviewTool == nil || *cfg.Builtin.CUA.IncludeOverviewTool,
			DisplaySelector: cua.DisplaySelector{
				Mode:       cfg.Builtin.CUA.DisplaySelector.Mode,
				Index:      cfg.Builtin.CUA.DisplaySelector.Index,
				ID:         cfg.Builtin.CUA.DisplaySelector.ID,
				ElectronID: cfg.Builtin.CUA.DisplaySelector.ElectronID,
			},
		})
		if err != nil {
			return nil, err
		}
		return &builtinAdapter{inner: server}, nil
	case "filesystem":
		if cfg.Builtin.Filesystem == nil {
			return nil, fmt.Errorf("builtin.filesystem config is required")
		}

		roots := make([]filesystem.Root, 0, len(cfg.Builtin.Filesystem.Roots))
		for index, root := range cfg.Builtin.Filesystem.Roots {
			roots = append(roots, filesystem.Root{
				ID:     fmt.Sprintf("root_%d", index),
				Path:   root.Path,
				Access: root.Access,
			})
		}

		server, err := filesystem.New(filesystem.Config{
			StableKey:           cfg.StableKey,
			Name:                cfg.Name,
			Enabled:             enabled,
			ReadOnly:            cfg.Builtin.Filesystem.ReadOnly != nil && *cfg.Builtin.Filesystem.ReadOnly,
			Scope:               cfg.Builtin.Filesystem.Scope,
			GlobalAccess:        cfg.Builtin.Filesystem.GlobalAccess,
			MaxGetFileSizeBytes: cfg.Builtin.Filesystem.MaxGetFileSizeBytes,
			Roots:               roots,
			Index: filesystem.IndexConfig{
				Dir:              filepath.Join(relaypaths.Current().FilesystemIndexesDir, "filesystem", cfg.StableKey),
				ContentEnabled:   cfg.Builtin.Filesystem.Index.ContentEnabled != nil && *cfg.Builtin.Filesystem.Index.ContentEnabled,
				FileTypes:        cfg.Builtin.Filesystem.Index.FileTypes,
				MaxFileSizeBytes: cfg.Builtin.Filesystem.Index.MaxFileSizeBytes,
				ParsePDF:         cfg.Builtin.Filesystem.Index.ParsePDF == nil || *cfg.Builtin.Filesystem.Index.ParsePDF,
				ParseOffice:      cfg.Builtin.Filesystem.Index.ParseOffice == nil || *cfg.Builtin.Filesystem.Index.ParseOffice,
				ParseImages:      cfg.Builtin.Filesystem.Index.ParseImages == nil || *cfg.Builtin.Filesystem.Index.ParseImages,
			},
			Backup: filesystem.BackupConfig{
				Dir:               filepath.Join(relaypaths.Current().FilesystemBackupsDir, "filesystem", cfg.StableKey),
				Enabled:           cfg.Builtin.Filesystem.Backup.Enabled == nil || *cfg.Builtin.Filesystem.Backup.Enabled,
				MaxTotalSizeBytes: cfg.Builtin.Filesystem.Backup.MaxTotalSizeBytes,
				MaxFileSizeBytes:  cfg.Builtin.Filesystem.Backup.MaxFileSizeBytes,
			},
		})
		if err != nil {
			return nil, err
		}
		return &builtinAdapter{inner: server}, nil
	case "commandline":
		if cfg.Builtin.Commandline == nil {
			return nil, fmt.Errorf("builtin.commandline config is required")
		}

		server, err := commandline.New(commandline.Config{
			Name:       cfg.Name,
			InstanceID: cfg.Builtin.InstanceID,
			Enabled:    enabled,
			DefaultCWD: cfg.Builtin.Commandline.DefaultCWD,
			MaxTimeout: time.Duration(cfg.Builtin.Commandline.MaxTimeoutSec) * time.Second,
		})
		if err != nil {
			return nil, err
		}
		return &builtinAdapter{inner: server}, nil
	default:
		return nil, fmt.Errorf("unsupported builtin kind %q", cfg.Builtin.Kind)
	}
}

func (b *builtinAdapter) Start(ctx context.Context) error {
	return b.inner.Start(ctx)
}

func (b *builtinAdapter) Initialize() error {
	return b.inner.Initialize()
}

func (b *builtinAdapter) ListTools() ([]Tool, error) {
	tools, err := b.inner.ListTools()
	if err != nil {
		return nil, err
	}

	result := make([]Tool, 0, len(tools))
	for _, tool := range tools {
		result = append(result, Tool{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: tool.InputSchema,
			Parameters:  tool.InputSchema,
		})
	}
	return result, nil
}

func (b *builtinAdapter) CallTool(ctx context.Context, toolName string, args map[string]interface{}) (interface{}, error) {
	result, err := b.inner.CallTool(ctx, toolName, args)
	if err != nil {
		return nil, err
	}

	return map[string]interface{}{
		"content":           result.Content,
		"structuredContent": result.StructuredContent,
		"isError":           result.IsError,
	}, nil
}

func (b *builtinAdapter) Shutdown() {
	b.inner.Shutdown()
}

func (b *builtinAdapter) Metadata() map[string]interface{} {
	provider, ok := b.inner.(interface{ Metadata() map[string]interface{} })
	if !ok {
		return map[string]interface{}{}
	}
	metadata := provider.Metadata()
	if metadata == nil {
		return map[string]interface{}{}
	}
	return metadata
}

func (b *builtinAdapter) StartTask(
	ctx context.Context,
	toolName string,
	args map[string]interface{},
	requestedTaskID string,
) (core.TaskSnapshot, error) {
	taskCapable, ok := b.inner.(core.TaskCapable)
	if !ok {
		return core.TaskSnapshot{}, core.ErrTaskNotSupported
	}
	return taskCapable.StartTask(ctx, toolName, args, requestedTaskID)
}

func (b *builtinAdapter) GetTask(taskID string) (core.TaskSnapshot, error) {
	taskCapable, ok := b.inner.(core.TaskCapable)
	if !ok {
		return core.TaskSnapshot{}, core.ErrTaskNotSupported
	}
	return taskCapable.GetTask(taskID)
}

func (b *builtinAdapter) ReadTaskOutput(
	taskID string,
	afterSeq int64,
	limit int,
	stream string,
) ([]core.TaskOutputChunk, error) {
	taskCapable, ok := b.inner.(core.TaskCapable)
	if !ok {
		return nil, core.ErrTaskNotSupported
	}
	return taskCapable.ReadTaskOutput(taskID, afterSeq, limit, stream)
}

func (b *builtinAdapter) CancelTask(taskID string, reason string) error {
	taskCapable, ok := b.inner.(core.TaskCapable)
	if !ok {
		return core.ErrTaskNotSupported
	}
	return taskCapable.CancelTask(taskID, reason)
}

func (b *builtinAdapter) CloseRuntimeSession(runtimeSessionID string) {
	if aware, ok := b.inner.(core.RuntimeSessionAware); ok {
		aware.CloseRuntimeSession(runtimeSessionID)
	}
}

func (b *builtinAdapter) OpenRuntimeSession(runtimeSessionID string) error {
	if aware, ok := b.inner.(core.RuntimeSessionAware); ok {
		return aware.OpenRuntimeSession(runtimeSessionID)
	}
	return nil
}

func (b *builtinAdapter) ResetRuntimeSessions() {
	if aware, ok := b.inner.(core.RuntimeSessionAware); ok {
		aware.ResetRuntimeSessions()
	}
}

func (b *builtinAdapter) SetEventEmitter(handler func(string, string, map[string]interface{})) {
	if aware, ok := b.inner.(eventEmitterAware); ok {
		aware.SetEventEmitter(handler)
	}
}

func (b *builtinAdapter) SetCUASessionTerminator(handler func(string, string)) {
	if aware, ok := b.inner.(cuaTerminatorAware); ok {
		aware.SetCUASessionTerminator(handler)
	}
}
