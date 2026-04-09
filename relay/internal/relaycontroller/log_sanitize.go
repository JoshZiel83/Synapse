package relaycontroller

import (
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/PekingSpades/Synapse/relay/internal/relay"
)

const (
	maxLogMessageBytes    = 1024
	maxLogStringBytes     = 1024
	maxLogCollectionItems = 24
	maxLogDepth           = 4
)

func sanitizeRelayEvent(evt relay.Event) relay.Event {
	evt.Message = sanitizeLogText(evt.Message, maxLogMessageBytes)
	evt.Data = SanitizeLogData(evt.Data)
	return evt
}

func SanitizeLogData(input map[string]interface{}) map[string]interface{} {
	return sanitizeLogMap(input, 0)
}

func sanitizeLogMap(input map[string]interface{}, depth int) map[string]interface{} {
	if len(input) == 0 {
		return map[string]interface{}{}
	}
	if depth >= maxLogDepth {
		return map[string]interface{}{
			"_truncated": fmt.Sprintf("max depth %d reached", maxLogDepth),
		}
	}

	output := make(map[string]interface{}, 0)
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	limit := len(keys)
	if limit > maxLogCollectionItems {
		limit = maxLogCollectionItems
	}
	for _, key := range keys[:limit] {
		output[key] = sanitizeLogValue(input[key], depth+1)
	}
	if len(keys) > maxLogCollectionItems {
		output["_truncatedKeys"] = len(keys) - maxLogCollectionItems
	}
	return output
}

func sanitizeLogValue(value interface{}, depth int) interface{} {
	if value == nil {
		return nil
	}
	if depth >= maxLogDepth {
		return sanitizeLogText(fmt.Sprint(value), maxLogStringBytes)
	}

	switch typed := value.(type) {
	case string:
		return sanitizeLogText(typed, maxLogStringBytes)
	case bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, uintptr, float32, float64:
		return typed
	case map[string]interface{}:
		return sanitizeLogMap(typed, depth+1)
	case []interface{}:
		return sanitizeLogSlice(typed, depth+1)
	}

	raw := reflect.ValueOf(value)
	for raw.Kind() == reflect.Pointer || raw.Kind() == reflect.Interface {
		if raw.IsNil() {
			return nil
		}
		raw = raw.Elem()
	}

	switch raw.Kind() {
	case reflect.Map:
		if raw.Type().Key().Kind() != reflect.String {
			return sanitizeLogText(fmt.Sprint(value), maxLogStringBytes)
		}
		keys := raw.MapKeys()
		sortedKeys := make([]string, 0, len(keys))
		for _, key := range keys {
			sortedKeys = append(sortedKeys, key.String())
		}
		sort.Strings(sortedKeys)

		output := make(map[string]interface{}, 0)
		limit := len(sortedKeys)
		if limit > maxLogCollectionItems {
			limit = maxLogCollectionItems
		}
		for _, key := range sortedKeys[:limit] {
			output[key] = sanitizeLogValue(raw.MapIndex(reflect.ValueOf(key)).Interface(), depth+1)
		}
		if len(sortedKeys) > maxLogCollectionItems {
			output["_truncatedKeys"] = len(sortedKeys) - maxLogCollectionItems
		}
		return output
	case reflect.Slice, reflect.Array:
		if raw.Kind() == reflect.Slice && raw.Type().Elem().Kind() == reflect.Uint8 {
			return fmt.Sprintf("<%d bytes>", raw.Len())
		}
		items := make([]interface{}, 0, min(raw.Len(), maxLogCollectionItems)+1)
		limit := raw.Len()
		if limit > maxLogCollectionItems {
			limit = maxLogCollectionItems
		}
		for i := 0; i < limit; i++ {
			items = append(items, sanitizeLogValue(raw.Index(i).Interface(), depth+1))
		}
		if raw.Len() > maxLogCollectionItems {
			items = append(items, fmt.Sprintf("... (%d more item(s))", raw.Len()-maxLogCollectionItems))
		}
		return items
	default:
		return sanitizeLogText(fmt.Sprint(value), maxLogStringBytes)
	}
}

func sanitizeLogSlice(values []interface{}, depth int) []interface{} {
	limit := len(values)
	if limit > maxLogCollectionItems {
		limit = maxLogCollectionItems
	}
	result := make([]interface{}, 0, limit+1)
	for _, value := range values[:limit] {
		result = append(result, sanitizeLogValue(value, depth))
	}
	if len(values) > maxLogCollectionItems {
		result = append(result, fmt.Sprintf("... (%d more item(s))", len(values)-maxLogCollectionItems))
	}
	return result
}

func sanitizeLogText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 || len(value) <= limit {
		return value
	}
	if limit <= 64 {
		return value[:limit]
	}
	suffix := fmt.Sprintf("...[truncated %d byte(s)]", len(value)-limit)
	prefixLimit := limit - len(suffix)
	if prefixLimit < 0 {
		prefixLimit = 0
	}
	return value[:prefixLimit] + suffix
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
