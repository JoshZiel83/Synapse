package main

import (
	"testing"

	"github.com/PekingSpades/Synapse/relay/internal/config"
)

func TestNormalizeCloseBehavior(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "ask default", input: "", want: config.CloseBehaviorAsk},
		{name: "tray lower", input: "tray", want: config.CloseBehaviorTray},
		{name: "quit upper", input: "QUIT", want: config.CloseBehaviorQuit},
		{name: "invalid", input: "later", want: config.CloseBehaviorAsk},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := normalizeCloseBehavior(test.input); got != test.want {
				t.Fatalf("expected %q, got %q", test.want, got)
			}
		})
	}
}

func TestNormalizeCloseAction(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "tray", input: "tray", want: config.CloseBehaviorTray},
		{name: "quit", input: "quit", want: config.CloseBehaviorQuit},
		{name: "cancel", input: "cancel", want: closeActionCancel},
		{name: "invalid", input: "dismiss", want: closeActionCancel},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := normalizeCloseAction(test.input); got != test.want {
				t.Fatalf("expected %q, got %q", test.want, got)
			}
		})
	}
}
