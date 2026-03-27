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

type RuntimeSessionAware interface {
	CloseRuntimeSession(runtimeSessionID string)
	ResetRuntimeSessions()
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

type ResourceDescriptor struct {
	Text     string                 `json:"text,omitempty"`
	Blob     string                 `json:"blob,omitempty"`
	MimeType string                 `json:"mimeType,omitempty"`
	URI      string                 `json:"uri,omitempty"`
	Name     string                 `json:"name,omitempty"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
}

type ResourceContent struct {
	Type     string             `json:"type"`
	Resource ResourceDescriptor `json:"resource"`
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

func BinaryResource(name, mimeType, blob string, metadata map[string]interface{}) ResourceContent {
	return ResourceContent{
		Type: "resource",
		Resource: ResourceDescriptor{
			Name:     name,
			Blob:     blob,
			MimeType: mimeType,
			Metadata: metadata,
		},
	}
}
