package relaycontroller

import (
	"strings"
	"testing"
)

func TestSanitizeLogDataTruncatesLargeNestedPayloads(t *testing.T) {
	t.Parallel()

	oversizedText := strings.Repeat("x", maxLogStringBytes+256)
	oversizedList := make([]interface{}, 0, maxLogCollectionItems+3)
	for i := 0; i < maxLogCollectionItems+3; i++ {
		oversizedList = append(oversizedList, i)
	}

	sanitized := SanitizeLogData(map[string]interface{}{
		"text": oversizedText,
		"nested": map[string]interface{}{
			"items": oversizedList,
		},
	})

	text, ok := sanitized["text"].(string)
	if !ok {
		t.Fatalf("expected sanitized text string, got %T", sanitized["text"])
	}
	if !strings.Contains(text, "[truncated") {
		t.Fatalf("expected oversized text to be truncated, got %q", text)
	}

	nested, ok := sanitized["nested"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected nested map, got %T", sanitized["nested"])
	}
	items, ok := nested["items"].([]interface{})
	if !ok {
		t.Fatalf("expected nested items slice, got %T", nested["items"])
	}
	if len(items) != maxLogCollectionItems+1 {
		t.Fatalf("expected capped collection size %d+1 marker, got %d", maxLogCollectionItems, len(items))
	}
	if tail, ok := items[len(items)-1].(string); !ok || !strings.Contains(tail, "more item(s)") {
		t.Fatalf("expected trailing truncation marker, got %#v", items[len(items)-1])
	}
}
