package relayagent

import (
	"context"
	"encoding/base64"
	"encoding/json"

	"github.com/PekingSpades/Synapse/relay/internal/cloud"
	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/relay"
	"github.com/PekingSpades/Synapse/relay/internal/relaycontroller"
	"github.com/PekingSpades/Synapse/relay/internal/relayipc"
)

type Client struct {
	rpc *relayipc.Client
}

func Dial(ctx context.Context, address string, hello relayipc.HelloParams) (*Client, error) {
	rpc, err := relayipc.Dial(ctx, address, hello)
	if err != nil {
		return nil, err
	}
	return &Client{rpc: rpc}, nil
}

func (c *Client) Close() error {
	if c == nil || c.rpc == nil {
		return nil
	}
	return c.rpc.Close()
}

func (c *Client) OnRelayEvent(handler func(relay.Event)) {
	if c == nil || c.rpc == nil || handler == nil {
		return
	}
	c.rpc.OnNotification("relay.event", func(raw json.RawMessage) {
		var evt relay.Event
		if err := json.Unmarshal(raw, &evt); err == nil {
			handler(evt)
		}
	})
}

func (c *Client) GetConfig(ctx context.Context) (*config.Config, error) {
	var cfg config.Config
	if err := c.rpc.Call(ctx, "config.get", map[string]interface{}{}, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Client) ApplyConfig(ctx context.Context, cfg *config.Config) (*relaycontroller.ApplyConfigResult, error) {
	var result relaycontroller.ApplyConfigResult
	if err := c.rpc.Call(ctx, "config.apply", ApplyConfigParams{Config: *cfg}, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) ClaimPairing(ctx context.Context, serverBaseURL, pairingCode, displayName string) (*cloud.PairingClaimResult, error) {
	var result cloud.PairingClaimResult
	if err := c.rpc.Call(ctx, "pairing.claim", PairingParams{
		ServerBaseURL: serverBaseURL,
		PairingCode:   pairingCode,
		DisplayName:   displayName,
	}, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) StartRelay(ctx context.Context) error {
	return c.rpc.Call(ctx, "relay.start", map[string]interface{}{}, nil)
}

func (c *Client) StopRelay(ctx context.Context) error {
	return c.rpc.Call(ctx, "relay.stop", map[string]interface{}{}, nil)
}

func (c *Client) RestartRelay(ctx context.Context) error {
	return c.rpc.Call(ctx, "relay.restart", map[string]interface{}{}, nil)
}

func (c *Client) GetStatus(ctx context.Context, includeServers bool) (relaycontroller.StatusInfo, error) {
	var result relaycontroller.StatusInfo
	err := c.rpc.Call(ctx, "status.get", StatusParams{IncludeServers: includeServers}, &result)
	return result, err
}

func (c *Client) GetRecentLogs(ctx context.Context, count int) ([]relaycontroller.LogEntry, error) {
	var result []relaycontroller.LogEntry
	err := c.rpc.Call(ctx, "logs.tail", RecentLogsParams{Count: count}, &result)
	return result, err
}

func (c *Client) Quit(ctx context.Context) error {
	return c.rpc.Call(ctx, "app.quit", map[string]interface{}{}, nil)
}

func (c *Client) VFSList(ctx context.Context, path string) ([]map[string]interface{}, error) {
	var result []map[string]interface{}
	err := c.rpc.Call(ctx, "vfs.list", VFSPathParams{Path: path}, &result)
	return result, err
}

func (c *Client) VFSStat(ctx context.Context, path string) (map[string]interface{}, error) {
	var result map[string]interface{}
	err := c.rpc.Call(ctx, "vfs.stat", VFSPathParams{Path: path}, &result)
	return result, err
}

func (c *Client) VFSRead(ctx context.Context, path string) (VFSReadResponse, []byte, error) {
	var result VFSReadResponse
	if err := c.rpc.Call(ctx, "vfs.read", VFSPathParams{Path: path}, &result); err != nil {
		return VFSReadResponse{}, nil, err
	}
	data, err := base64.StdEncoding.DecodeString(result.DataBase64)
	return result, data, err
}

func (c *Client) VFSWrite(ctx context.Context, path string, data []byte) (VFSWriteResponse, []byte, error) {
	var result VFSWriteResponse
	if err := c.rpc.Call(ctx, "vfs.write", VFSWriteParams{
		Path:       path,
		DataBase64: base64.StdEncoding.EncodeToString(data),
	}, &result); err != nil {
		return VFSWriteResponse{}, nil, err
	}
	decoded, err := base64.StdEncoding.DecodeString(result.DataBase64)
	return result, decoded, err
}
