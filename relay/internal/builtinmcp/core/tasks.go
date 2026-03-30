package core

import (
	"context"
	"errors"
)

type TaskStatus string

const (
	TaskStatusWorking   TaskStatus = "working"
	TaskStatusCompleted TaskStatus = "completed"
	TaskStatusFailed    TaskStatus = "failed"
	TaskStatusCancelled TaskStatus = "cancelled"
)

var ErrTaskNotFound = errors.New("task not found")
var ErrTaskNotSupported = errors.New("task not supported")

type TaskOutputChunk struct {
	Seq       int64  `json:"seq"`
	Stream    string `json:"stream"`
	Text      string `json:"text"`
	CreatedAt string `json:"createdAt"`
}

type TaskSnapshot struct {
	TaskID             string      `json:"taskId"`
	ToolName           string      `json:"toolName"`
	Status             TaskStatus  `json:"status"`
	StatusMessage      string      `json:"statusMessage,omitempty"`
	SupportsCancel     bool        `json:"supportsCancel"`
	SupportsOutputTail bool        `json:"supportsOutputTail"`
	LastOutputSeq      int64       `json:"lastOutputSeq,omitempty"`
	StartedAt          string      `json:"startedAt,omitempty"`
	UpdatedAt          string      `json:"updatedAt,omitempty"`
	CompletedAt        string      `json:"completedAt,omitempty"`
	Result             *CallResult `json:"result,omitempty"`
}

type TaskCapable interface {
	StartTask(
		ctx context.Context,
		toolName string,
		args map[string]interface{},
		requestedTaskID string,
	) (TaskSnapshot, error)
	GetTask(taskID string) (TaskSnapshot, error)
	ReadTaskOutput(
		taskID string,
		afterSeq int64,
		limit int,
		stream string,
	) ([]TaskOutputChunk, error)
	CancelTask(taskID string, reason string) error
}
