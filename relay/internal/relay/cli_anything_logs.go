package relay

import (
	"fmt"
	"sort"
	"strings"

	"github.com/PekingSpades/Synapse/relay/internal/mcp"
)

type cliAnythingCapabilityStatus struct {
	ServerName      string
	ServerStableKey string
	Command         string
	Module          string
	Version         string
	Ready           bool
	Reason          string
}

func (e *Engine) emitCLIAnythingCapabilityLogs(servers []mcp.ServerInfo) {
	for _, group := range collectCLIAnythingCapabilityStatuses(servers) {
		readyCount := 0
		for _, capability := range group {
			if capability.Ready {
				readyCount++
			}
		}

		summary := NewEvent(
			EventLog,
			fmt.Sprintf(
				"CLI-Anything readiness for %s: %d/%d ready.",
				group[0].ServerName,
				readyCount,
				len(group),
			),
		)
		summary.Data = map[string]interface{}{
			"server":                 group[0].ServerName,
			"stableKey":              group[0].ServerStableKey,
			"phase":                  "cli_anything_readiness",
			"cliAnythingTotalCount":  len(group),
			"cliAnythingReadyCount":  readyCount,
			"cliAnythingFailedCount": len(group) - readyCount,
		}
		e.emit(summary)

		for _, capability := range group {
			message := fmt.Sprintf(
				"CLI-Anything ready on %s: %s",
				capability.ServerName,
				capability.Command,
			)
			if !capability.Ready {
				message = fmt.Sprintf(
					"CLI-Anything failed on %s: %s (%s)",
					capability.ServerName,
					capability.Command,
					capability.Reason,
				)
			}

			evt := NewEvent(EventLog, message)
			evt.Data = map[string]interface{}{
				"server":    capability.ServerName,
				"stableKey": capability.ServerStableKey,
				"phase":     "cli_anything_readiness",
				"command":   capability.Command,
				"module":    capability.Module,
				"version":   capability.Version,
				"ready":     capability.Ready,
				"reason":    capability.Reason,
			}
			e.emit(evt)
		}
	}
}

func collectCLIAnythingCapabilityStatuses(servers []mcp.ServerInfo) [][]cliAnythingCapabilityStatus {
	grouped := make([][]cliAnythingCapabilityStatus, 0, len(servers))
	for _, server := range servers {
		capabilities := parseCLIAnythingCapabilityStatuses(server)
		if len(capabilities) == 0 {
			continue
		}
		sort.Slice(capabilities, func(i, j int) bool {
			return capabilities[i].Command < capabilities[j].Command
		})
		grouped = append(grouped, capabilities)
	}

	sort.Slice(grouped, func(i, j int) bool {
		left := grouped[i][0]
		right := grouped[j][0]
		if left.ServerName == right.ServerName {
			return left.ServerStableKey < right.ServerStableKey
		}
		return left.ServerName < right.ServerName
	})

	return grouped
}

func parseCLIAnythingCapabilityStatuses(server mcp.ServerInfo) []cliAnythingCapabilityStatus {
	if len(server.Metadata) == 0 {
		return nil
	}

	rawCapabilities, ok := server.Metadata["cliAnythingCapabilities"]
	if !ok {
		return nil
	}

	switch typed := rawCapabilities.(type) {
	case []map[string]interface{}:
		return mapCLIAnythingCapabilities(server, typed)
	case []interface{}:
		normalized := make([]map[string]interface{}, 0, len(typed))
		for _, item := range typed {
			capability, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			normalized = append(normalized, capability)
		}
		return mapCLIAnythingCapabilities(server, normalized)
	default:
		return nil
	}
}

func mapCLIAnythingCapabilities(server mcp.ServerInfo, capabilities []map[string]interface{}) []cliAnythingCapabilityStatus {
	statuses := make([]cliAnythingCapabilityStatus, 0, len(capabilities))
	for _, capability := range capabilities {
		command := stringMetadataValue(capability, "command")
		if command == "" {
			continue
		}

		statuses = append(statuses, cliAnythingCapabilityStatus{
			ServerName:      server.Name,
			ServerStableKey: server.StableKey,
			Command:         command,
			Module:          stringMetadataValue(capability, "module"),
			Version:         stringMetadataValue(capability, "version"),
			Ready:           boolMetadataValue(capability, "ready"),
			Reason:          stringMetadataValue(capability, "reason"),
		})
	}

	return statuses
}

func stringMetadataValue(input map[string]interface{}, key string) string {
	if input == nil {
		return ""
	}
	value, ok := input[key]
	if !ok {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func boolMetadataValue(input map[string]interface{}, key string) bool {
	if input == nil {
		return false
	}
	value, ok := input[key]
	if !ok {
		return false
	}
	typed, ok := value.(bool)
	if !ok {
		return false
	}
	return typed
}
