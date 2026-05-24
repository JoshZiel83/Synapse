package vfs

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/cloud"
	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/mcp"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
)

type Backend interface {
	Start(context.Context) error
	Close()
	Exposures() []Exposure
	CallTool(context.Context, string, string, map[string]interface{}) (interface{}, error)
	OpenRuntimeSession(context.Context, string, string) error
	CloseRuntimeSession(context.Context, string) error
}

type managerBackend struct {
	mgr       managerAPI
	exposures []Exposure
	mu        sync.Mutex
	cancel    context.CancelFunc
}

type managerAPI interface {
	InitAll(context.Context) error
	GetServerInfo() []mcp.ServerInfo
	ShutdownAll()
	CallTool(context.Context, string, string, map[string]interface{}) (interface{}, error)
	OpenRuntimeSession(context.Context, cloud.RuntimeSessionRequest) error
	CloseRuntimeSession(context.Context, string) error
}

func NewManagerBackend(paths relaypaths.ResolvedPaths, cfg *config.Config) (Backend, error) {
	if cfg == nil {
		return nil, fmt.Errorf("config is required")
	}
	vfsCfg, err := prepareVFSConfig(paths, cfg)
	if err != nil {
		return nil, err
	}
	return &managerBackend{
		mgr: mcp.NewManager(vfsCfg.Servers, vfsCfg.Security),
	}, nil
}

func (b *managerBackend) Start(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	startCtx, startCancel := context.WithTimeout(ctx, 45*time.Second)
	defer startCancel()

	lifetimeCtx, lifetimeCancel := context.WithCancel(context.Background())
	initDone := make(chan error, 1)
	go func() {
		initDone <- b.mgr.InitAll(lifetimeCtx)
	}()

	select {
	case err := <-initDone:
		if err != nil {
			lifetimeCancel()
			return err
		}
	case <-startCtx.Done():
		lifetimeCancel()
		err := <-initDone
		if err != nil && !errors.Is(err, context.Canceled) {
			return err
		}
		return startCtx.Err()
	}

	b.mu.Lock()
	if b.cancel != nil {
		b.cancel()
	}
	b.cancel = lifetimeCancel
	b.mu.Unlock()

	serverInfos := b.mgr.GetServerInfo()
	exposures := make([]Exposure, 0, len(serverInfos))
	for _, info := range serverInfos {
		capability, _ := info.Metadata["builtinKind"].(string)
		if capability != "browser" && capability != "cua" {
			continue
		}
		exposures = append(exposures, Exposure{
			Capability: capability,
			StableKey:  info.StableKey,
			Name:       info.Name,
			Metadata:   info.Metadata,
		})
	}
	if len(exposures) == 0 {
		return fmt.Errorf("no browser or cua builtin servers are available for relay vfs")
	}
	b.exposures = exposures
	return nil
}

func (b *managerBackend) Close() {
	b.mu.Lock()
	cancel := b.cancel
	b.cancel = nil
	b.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if b.mgr != nil {
		b.mgr.ShutdownAll()
	}
}

func (b *managerBackend) Exposures() []Exposure {
	out := make([]Exposure, len(b.exposures))
	copy(out, b.exposures)
	return out
}

func (b *managerBackend) CallTool(
	ctx context.Context,
	exposureStableKey string,
	toolName string,
	args map[string]interface{},
) (interface{}, error) {
	return b.mgr.CallTool(ctx, exposureStableKey, toolName, args)
}

func (b *managerBackend) OpenRuntimeSession(
	ctx context.Context,
	exposureStableKey string,
	runtimeSessionID string,
) error {
	return b.mgr.OpenRuntimeSession(ctx, cloud.RuntimeSessionRequest{
		RuntimeSessionID:  runtimeSessionID,
		ExposureStableKey: exposureStableKey,
	})
}

func (b *managerBackend) CloseRuntimeSession(ctx context.Context, runtimeSessionID string) error {
	return b.mgr.CloseRuntimeSession(ctx, runtimeSessionID)
}

func prepareVFSConfig(paths relaypaths.ResolvedPaths, cfg *config.Config) (*config.Config, error) {
	clone := config.Clone(cfg)

	servers := make([]config.ServerConfig, 0, len(clone.Servers))
	for _, server := range clone.Servers {
		if server.Transport != "builtin" || server.Builtin == nil {
			continue
		}
		kind := strings.TrimSpace(strings.ToLower(server.Builtin.Kind))
		switch kind {
		case "chrome":
			server.Enabled = boolPtr(true)
			if server.Builtin.Chrome != nil {
				server.Builtin.Chrome.Slim = boolPtr(false)
				if strings.TrimSpace(server.Builtin.Chrome.UserDataDir) == "" {
					server.Builtin.Chrome.UserDataDir = ""
				}
			}
			servers = append(servers, server)
		case "cua":
			if !cuaRuntimeSupported() {
				continue
			}
			server.Enabled = boolPtr(true)
			servers = append(servers, server)
		}
	}

	if len(servers) == 0 {
		return nil, fmt.Errorf("configure at least one builtin browser or cua server before using relay vfs")
	}

	clone.Servers = servers
	relaypaths.SetCurrent(paths)
	return clone, nil
}

func boolPtr(value bool) *bool {
	return &value
}
