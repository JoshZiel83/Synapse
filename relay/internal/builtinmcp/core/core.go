package core

import "context"

type Tool struct {
	Name        string
	Description string
	InputSchema interface{}
}

type CallResult struct {
	Content           []interface{}
	StructuredContent interface{}
	IsError           bool
}

type Server interface {
	Start(ctx context.Context) error
	Initialize() error
	ListTools() ([]Tool, error)
	CallTool(ctx context.Context, toolName string, args map[string]interface{}) (CallResult, error)
	Shutdown()
}

type TextContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type ImageContent struct {
	Type     string `json:"type"`
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
}

func Text(text string) TextContent {
	return TextContent{
		Type: "text",
		Text: text,
	}
}

func PNGImage(data string) ImageContent {
	return ImageContent{
		Type:     "image",
		Data:     data,
		MimeType: "image/png",
	}
}
