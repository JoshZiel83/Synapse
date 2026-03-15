package mcp

import (
	"context"
	"fmt"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/cua"
	"github.com/PekingSpades/Synapse/relay/internal/config"
)

type builtinAdapter struct {
	inner core.Server
}

func newBuiltinServer(cfg config.ServerConfig) (Server, error) {
	if cfg.Builtin == nil {
		return nil, fmt.Errorf("builtin config is required")
	}

	switch cfg.Builtin.Kind {
	case "cua":
		if cfg.Builtin.CUA == nil {
			return nil, fmt.Errorf("builtin.cua config is required")
		}
		server, err := cua.New(cua.Config{
			ReadOnly:             cfg.Builtin.CUA.ReadOnly != nil && *cfg.Builtin.CUA.ReadOnly,
			RelativeCoordinate:   cfg.Builtin.CUA.RelativeCoordinate,
			ImageSize:            cfg.Builtin.CUA.ImageSize,
			RelativeSize:         cfg.Builtin.CUA.RelativeSize,
			ScrollMultiplier:     cfg.Builtin.CUA.ScrollMultiplier,
			LogDir:               cfg.Builtin.CUA.LogDir,
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
