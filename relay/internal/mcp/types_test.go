package mcp

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestToolCallRequestIncludesEmptyArgumentsObject(t *testing.T) {
	req := ToolCallRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "tools/call",
	}
	req.Params.Name = "screenshot"
	req.Params.Arguments = map[string]interface{}{}

	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	text := string(data)
	if !strings.Contains(text, `"arguments":{}`) {
		t.Fatalf("expected empty arguments object to be preserved, got %s", text)
	}
}
