package relayagent

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/relay"
	"github.com/PekingSpades/Synapse/relay/internal/relaycontroller"
	"github.com/PekingSpades/Synapse/relay/internal/relayipc"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
)

type ApplyConfigParams struct {
	Config config.Config `json:"config"`
}

type PairingParams struct {
	ServerBaseURL string `json:"serverBaseUrl"`
	PairingCode   string `json:"pairingCode"`
	DisplayName   string `json:"displayName,omitempty"`
}

type RecentLogsParams struct {
	Count int `json:"count"`
}

type StatusParams struct {
	IncludeServers bool `json:"includeServers"`
}

type Agent struct {
	controller *relaycontroller.Controller
	server     *relayipc.Server

	stopOnce sync.Once
	stopCh   chan struct{}
}

func New(paths relaypaths.ResolvedPaths, address string, auth relayipc.HelloParams, version string) (*Agent, error) {
	controller, err := relaycontroller.New(paths, version)
	if err != nil {
		return nil, err
	}

	agent := &Agent{
		controller: controller,
		stopCh:     make(chan struct{}),
	}

	server := relayipc.NewServer(address, auth, version, agent.handleRPC)
	controller.OnEvent(func(evt relay.Event) {
		server.Notify("relay.event", evt)
	})
	agent.server = server
	return agent, nil
}

func (a *Agent) Start(ctx context.Context) error {
	return a.server.Start(ctx)
}

func (a *Agent) Wait() {
	<-a.stopCh
}

func (a *Agent) Stop() error {
	var err error
	a.stopOnce.Do(func() {
		if stopErr := a.controller.Shutdown(); stopErr != nil {
			err = stopErr
		}
		if closeErr := a.server.Close(); err == nil && closeErr != nil {
			err = closeErr
		}
		close(a.stopCh)
	})
	return err
}

func (a *Agent) handleRPC(ctx context.Context, method string, raw json.RawMessage) (interface{}, *relayipc.RPCError) {
	switch method {
	case "ping":
		return map[string]string{"status": "ok"}, nil
	case "config.get":
		return a.controller.GetConfig(), nil
	case "config.apply":
		var params ApplyConfigParams
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		result, err := a.controller.ApplyConfig(&params.Config)
		if err != nil {
			return nil, internalError(err)
		}
		return result, nil
	case "pairing.claim":
		var params PairingParams
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		result, err := a.controller.ClaimPairing(params.ServerBaseURL, params.PairingCode, params.DisplayName)
		if err != nil {
			return nil, internalError(err)
		}
		return result, nil
	case "relay.start":
		if err := a.controller.StartRelay(); err != nil {
			return nil, internalError(err)
		}
		return map[string]string{"status": "started"}, nil
	case "relay.stop":
		if err := a.controller.StopRelay(); err != nil {
			return nil, internalError(err)
		}
		return map[string]string{"status": "stopped"}, nil
	case "relay.restart":
		if err := a.controller.RestartRelay(); err != nil {
			return nil, internalError(err)
		}
		return map[string]string{"status": "restarted"}, nil
	case "status.get":
		var params StatusParams
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &params); err != nil {
				return nil, invalidParams(err)
			}
		}
		return a.controller.GetStatus(params.IncludeServers), nil
	case "logs.tail":
		var params RecentLogsParams
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &params); err != nil {
				return nil, invalidParams(err)
			}
		}
		return a.controller.GetRecentLogs(params.Count), nil
	case "app.quit":
		go func() {
			_ = a.Stop()
		}()
		return map[string]string{"status": "quitting"}, nil
	default:
		return nil, &relayipc.RPCError{
			Code:    -32601,
			Message: fmt.Sprintf("unknown method %q", method),
		}
	}
}

func invalidParams(err error) *relayipc.RPCError {
	return &relayipc.RPCError{
		Code:    -32602,
		Message: fmt.Sprintf("invalid params: %v", err),
	}
}

func internalError(err error) *relayipc.RPCError {
	return &relayipc.RPCError{
		Code:    -32000,
		Message: err.Error(),
	}
}
