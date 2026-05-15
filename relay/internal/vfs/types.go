package vfs

import "time"

type NodeKind string

const (
	NodeKindDirectory NodeKind = "directory"
	NodeKindFile      NodeKind = "file"
)

type Entry struct {
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	Kind     NodeKind  `json:"kind"`
	Size     int64     `json:"size,omitempty"`
	Writable bool      `json:"writable,omitempty"`
	MimeType string    `json:"mimeType,omitempty"`
	ModTime  time.Time `json:"modTime,omitempty"`
}

type ReadResult struct {
	Data     []byte `json:"-"`
	MimeType string `json:"mimeType"`
	Writable bool   `json:"writable,omitempty"`
}

type WriteResult struct {
	Data     []byte `json:"-"`
	MimeType string `json:"mimeType"`
}

type Exposure struct {
	Capability string                 `json:"capability"`
	StableKey  string                 `json:"stableKey"`
	Name       string                 `json:"name"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
}

type SessionState struct {
	Capability        string    `json:"capability"`
	ExposureStableKey string    `json:"exposureStableKey"`
	SessionID         string    `json:"sessionId"`
	RuntimeSessionID  string    `json:"runtimeSessionId"`
	SelectedPageID    int       `json:"selectedPageId,omitempty"`
	CreatedAt         time.Time `json:"createdAt"`
}
