package relay

import (
	"fmt"
	"sort"
	"strings"

	"github.com/PekingSpades/Synapse/relay/internal/mcp"
)

type managedCapabilityStatus struct {
	ServerName          string
	ServerStableKey     string
	Provider            string
	ProviderDisplayName string
	Command             string
	Module              string
	Version             string
	Ready               bool
	Reason              string
}

func (e *Engine) emitCLIAnythingCapabilityLogs(servers []mcp.ServerInfo) {
	for _, group := range collectManagedCapabilityStatuses(servers) {
		readyCount := 0
		for _, capability := range group {
			if capability.Ready {
				readyCount++
			}
		}

		providerDisplayName := group[0].ProviderDisplayName
		if providerDisplayName == "" {
			providerDisplayName = group[0].Provider
		}
		summary := NewEvent(
			EventLog,
			fmt.Sprintf(
				"Managed CLI readiness for %s / %s: %d/%d ready.",
				group[0].ServerName,
				providerDisplayName,
				readyCount,
				len(group),
			),
		)
		summary.Data = map[string]interface{}{
			"server":                 group[0].ServerName,
			"stableKey":              group[0].ServerStableKey,
			"provider":               group[0].Provider,
			"providerDisplayName":    providerDisplayName,
			"phase":                  "managed_cli_readiness",
			"managedCapabilityCount": len(group),
			"managedReadyCount":      readyCount,
			"managedFailedCount":     len(group) - readyCount,
		}
		e.emit(summary)

		for _, capability := range group {
			message := fmt.Sprintf(
				"Managed CLI ready on %s / %s: %s",
				capability.ServerName,
				providerDisplayName,
				capability.Command,
			)
			if !capability.Ready {
				message = fmt.Sprintf(
					"Managed CLI failed on %s / %s: %s (%s)",
					capability.ServerName,
					providerDisplayName,
					capability.Command,
					capability.Reason,
				)
			}

			evt := NewEvent(EventLog, message)
			evt.Data = map[string]interface{}{
				"server":              capability.ServerName,
				"stableKey":           capability.ServerStableKey,
				"provider":            capability.Provider,
				"providerDisplayName": providerDisplayName,
				"phase":               "managed_cli_readiness",
				"command":             capability.Command,
				"module":              capability.Module,
				"version":             capability.Version,
				"ready":               capability.Ready,
				"reason":              capability.Reason,
			}
			e.emit(evt)
		}
	}
}

func collectManagedCapabilityStatuses(servers []mcp.ServerInfo) [][]managedCapabilityStatus {
	grouped := make([][]managedCapabilityStatus, 0, len(servers))
	for _, server := range servers {
		capabilities := parseManagedCapabilityStatuses(server)
		if len(capabilities) == 0 {
			continue
		}

		groupsByProvider := make(map[string][]managedCapabilityStatus)
		for _, capability := range capabilities {
			key := capability.Provider
			if key == "" {
				key = "_default"
			}
			groupsByProvider[key] = append(groupsByProvider[key], capability)
		}

		for _, providerGroup := range groupsByProvider {
			sort.Slice(providerGroup, func(i, j int) bool {
				return providerGroup[i].Command < providerGroup[j].Command
			})
			grouped = append(grouped, providerGroup)
		}
	}

	sort.Slice(grouped, func(i, j int) bool {
		left := grouped[i][0]
		right := grouped[j][0]
		if left.ServerName == right.ServerName {
			if left.Provider == right.Provider {
				return left.Command < right.Command
			}
			return left.Provider < right.Provider
		}
		return left.ServerName < right.ServerName
	})

	return grouped
}

func parseManagedCapabilityStatuses(server mcp.ServerInfo) []managedCapabilityStatus {
	if len(server.Metadata) == 0 {
		return nil
	}

	rawCapabilities, ok := server.Metadata["managedCapabilities"]
	if !ok {
		return nil
	}

	switch typed := rawCapabilities.(type) {
	case []map[string]interface{}:
		return mapManagedCapabilities(server, typed)
	case []interface{}:
		normalized := make([]map[string]interface{}, 0, len(typed))
		for _, item := range typed {
			capability, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			normalized = append(normalized, capability)
		}
		return mapManagedCapabilities(server, normalized)
	default:
		return nil
	}
}

func mapManagedCapabilities(server mcp.ServerInfo, capabilities []map[string]interface{}) []managedCapabilityStatus {
	statuses := make([]managedCapabilityStatus, 0, len(capabilities))
	for _, capability := range capabilities {
		command := stringMetadataValue(capability, "command")
		if command == "" {
			continue
		}

		statuses = append(statuses, managedCapabilityStatus{
			ServerName:          server.Name,
			ServerStableKey:     server.StableKey,
			Provider:            stringMetadataValue(capability, "provider"),
			ProviderDisplayName: stringMetadataValue(capability, "providerDisplayName"),
			Command:             command,
			Module:              stringMetadataValue(capability, "module"),
			Version:             stringMetadataValue(capability, "version"),
			Ready:               boolMetadataValue(capability, "ready"),
			Reason:              stringMetadataValue(capability, "reason"),
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
