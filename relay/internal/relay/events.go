package relay

import "time"

// EventType represents the type of relay event
type EventType string

const (
	EventConnecting     EventType = "connecting"
	EventConnected      EventType = "connected"
	EventDisconnected   EventType = "disconnected"
	EventAuthFailed     EventType = "auth_failed"
	EventServersReady   EventType = "servers_ready"
	EventToolCall       EventType = "tool_call"
	EventToolResult     EventType = "tool_result"
	EventError          EventType = "error"
	EventLog            EventType = "log"
	EventStateChanged   EventType = "state_changed"
	EventServerInit     EventType = "server_init"
	EventServerPending  EventType = "server_pending"
	EventServerReady    EventType = "server_ready"
	EventServerFailed   EventType = "server_failed"
	EventCatalogHint    EventType = "catalog_hint"
	EventCatalogChanged EventType = "catalog_changed"
)

// Event is emitted by the relay engine and its components
type Event struct {
	Type      EventType              `json:"type"`
	Message   string                 `json:"message"`
	Timestamp time.Time              `json:"timestamp"`
	Data      map[string]interface{} `json:"data,omitempty"`
}

// EventListener is a callback for relay events
type EventListener func(Event)

// NewEvent creates an event with the current timestamp
func NewEvent(t EventType, msg string) Event {
	return Event{
		Type:      t,
		Message:   msg,
		Timestamp: time.Now(),
	}
}

// WithData returns a copy of the event with additional data
func (e Event) WithData(key string, value interface{}) Event {
	if e.Data == nil {
		e.Data = make(map[string]interface{})
	}
	e.Data[key] = value
	return e
}
