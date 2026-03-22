package main

import (
	"strings"

	"github.com/PekingSpades/Synapse/relay/internal/config"
)

const (
	closeActionCancel = "cancel"
)

func normalizeCloseBehavior(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case config.CloseBehaviorTray:
		return config.CloseBehaviorTray
	case config.CloseBehaviorQuit:
		return config.CloseBehaviorQuit
	default:
		return config.CloseBehaviorAsk
	}
}

func normalizeCloseAction(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case config.CloseBehaviorTray:
		return config.CloseBehaviorTray
	case config.CloseBehaviorQuit:
		return config.CloseBehaviorQuit
	default:
		return closeActionCancel
	}
}
