package filesystem

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"
	"gopkg.in/yaml.v3"
)

type structuredFormat string

const (
	structuredFormatJSON structuredFormat = "json"
	structuredFormatYAML structuredFormat = "yaml"
	structuredFormatTOML structuredFormat = "toml"
)

type structuredUpdate struct {
	Path   string      `json:"path"`
	Action string      `json:"action"`
	Value  interface{} `json:"value"`
}

type structuredPathToken struct {
	Key   *string
	Index *int
}

func inferStructuredFormat(filePath, explicit string) (structuredFormat, error) {
	switch strings.TrimSpace(strings.ToLower(explicit)) {
	case "":
	case "json":
		return structuredFormatJSON, nil
	case "yaml", "yml":
		return structuredFormatYAML, nil
	case "toml":
		return structuredFormatTOML, nil
	default:
		return "", fmt.Errorf("unsupported structured format %q", explicit)
	}

	switch strings.ToLower(filepath.Ext(filePath)) {
	case ".json":
		return structuredFormatJSON, nil
	case ".yaml", ".yml":
		return structuredFormatYAML, nil
	case ".toml":
		return structuredFormatTOML, nil
	default:
		return "", fmt.Errorf("could not infer structured format from %q; provide format explicitly", filePath)
	}
}

func parseStructuredDocument(filePath, explicit string, data []byte) (interface{}, structuredFormat, error) {
	format, err := inferStructuredFormat(filePath, explicit)
	if err != nil {
		return nil, "", err
	}

	var value interface{}
	switch format {
	case structuredFormatJSON:
		if err := json.Unmarshal(data, &value); err != nil {
			return nil, "", err
		}
	case structuredFormatYAML:
		if err := yaml.Unmarshal(data, &value); err != nil {
			return nil, "", err
		}
	case structuredFormatTOML:
		if err := toml.Unmarshal(data, &value); err != nil {
			return nil, "", err
		}
	default:
		return nil, "", fmt.Errorf("unsupported structured format %q", format)
	}
	return normalizeStructuredValue(value), format, nil
}

func marshalStructuredDocument(value interface{}, format structuredFormat) ([]byte, error) {
	value = normalizeStructuredValue(value)
	switch format {
	case structuredFormatJSON:
		data, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return nil, err
		}
		return append(data, '\n'), nil
	case structuredFormatYAML:
		return yaml.Marshal(value)
	case structuredFormatTOML:
		var buffer bytes.Buffer
		if err := toml.NewEncoder(&buffer).Encode(value); err != nil {
			return nil, err
		}
		return buffer.Bytes(), nil
	default:
		return nil, fmt.Errorf("unsupported structured format %q", format)
	}
}

func applyStructuredUpdates(document interface{}, updates []structuredUpdate) (interface{}, error) {
	current := normalizeStructuredValue(document)
	for _, update := range updates {
		tokens, err := parseStructuredPath(update.Path)
		if err != nil {
			return nil, err
		}
		action := strings.TrimSpace(strings.ToLower(update.Action))
		if action == "" {
			action = "set"
		}
		switch action {
		case "set":
			current, err = setStructuredValue(current, tokens, normalizeStructuredValue(update.Value))
		case "delete":
			current, err = deleteStructuredValue(current, tokens)
		default:
			err = fmt.Errorf("unsupported update action %q", update.Action)
		}
		if err != nil {
			return nil, fmt.Errorf("update %q failed: %w", update.Path, err)
		}
	}
	return current, nil
}

func parseStructuredPath(path string) ([]structuredPathToken, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("path is required")
	}
	tokens := make([]structuredPathToken, 0)
	var segment strings.Builder
	flushSegment := func() {
		if segment.Len() == 0 {
			return
		}
		value := segment.String()
		segment.Reset()
		tokens = append(tokens, structuredPathToken{Key: &value})
	}
	for index := 0; index < len(path); index++ {
		switch path[index] {
		case '.':
			flushSegment()
		case '[':
			flushSegment()
			end := strings.IndexByte(path[index:], ']')
			if end <= 1 {
				return nil, fmt.Errorf("invalid bracket segment in %q", path)
			}
			rawIndex := path[index+1 : index+end]
			parsedIndex, err := strconv.Atoi(rawIndex)
			if err != nil || parsedIndex < 0 {
				return nil, fmt.Errorf("invalid array index %q in %q", rawIndex, path)
			}
			tokens = append(tokens, structuredPathToken{Index: &parsedIndex})
			index += end
		default:
			segment.WriteByte(path[index])
		}
	}
	flushSegment()
	if len(tokens) == 0 {
		return nil, fmt.Errorf("path is required")
	}
	return tokens, nil
}

func setStructuredValue(current interface{}, tokens []structuredPathToken, value interface{}) (interface{}, error) {
	if len(tokens) == 0 {
		return value, nil
	}
	token := tokens[0]
	if token.Key != nil {
		var object map[string]interface{}
		switch typed := current.(type) {
		case nil:
			object = map[string]interface{}{}
		case map[string]interface{}:
			object = cloneStructuredObject(typed)
		default:
			return nil, fmt.Errorf("expected object at %q", *token.Key)
		}
		nextValue, err := setStructuredValue(object[*token.Key], tokens[1:], value)
		if err != nil {
			return nil, err
		}
		object[*token.Key] = nextValue
		return object, nil
	}

	var array []interface{}
	switch typed := current.(type) {
	case nil:
		array = []interface{}{}
	case []interface{}:
		array = append([]interface{}{}, typed...)
	default:
		return nil, fmt.Errorf("expected array at index %d", *token.Index)
	}
	for len(array) <= *token.Index {
		array = append(array, nil)
	}
	nextValue, err := setStructuredValue(array[*token.Index], tokens[1:], value)
	if err != nil {
		return nil, err
	}
	array[*token.Index] = nextValue
	return array, nil
}

func deleteStructuredValue(current interface{}, tokens []structuredPathToken) (interface{}, error) {
	if len(tokens) == 0 {
		return nil, fmt.Errorf("path is required")
	}
	token := tokens[0]
	if token.Key != nil {
		object, ok := current.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("expected object at %q", *token.Key)
		}
		if len(tokens) == 1 {
			if _, exists := object[*token.Key]; !exists {
				return nil, fmt.Errorf("path segment %q was not found", *token.Key)
			}
			cloned := cloneStructuredObject(object)
			delete(cloned, *token.Key)
			return cloned, nil
		}
		child, exists := object[*token.Key]
		if !exists {
			return nil, fmt.Errorf("path segment %q was not found", *token.Key)
		}
		updatedChild, err := deleteStructuredValue(child, tokens[1:])
		if err != nil {
			return nil, err
		}
		cloned := cloneStructuredObject(object)
		cloned[*token.Key] = updatedChild
		return cloned, nil
	}

	array, ok := current.([]interface{})
	if !ok {
		return nil, fmt.Errorf("expected array at index %d", *token.Index)
	}
	if *token.Index < 0 || *token.Index >= len(array) {
		return nil, fmt.Errorf("array index %d was not found", *token.Index)
	}
	if len(tokens) == 1 {
		cloned := append([]interface{}{}, array[:*token.Index]...)
		cloned = append(cloned, array[*token.Index+1:]...)
		return cloned, nil
	}
	updatedChild, err := deleteStructuredValue(array[*token.Index], tokens[1:])
	if err != nil {
		return nil, err
	}
	cloned := append([]interface{}{}, array...)
	cloned[*token.Index] = updatedChild
	return cloned, nil
}

func cloneStructuredObject(input map[string]interface{}) map[string]interface{} {
	cloned := make(map[string]interface{}, len(input))
	for key, value := range input {
		cloned[key] = value
	}
	return cloned
}

func normalizeStructuredValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case map[string]interface{}:
		normalized := make(map[string]interface{}, len(typed))
		for key, child := range typed {
			normalized[key] = normalizeStructuredValue(child)
		}
		return normalized
	case map[interface{}]interface{}:
		normalized := make(map[string]interface{}, len(typed))
		for key, child := range typed {
			normalized[fmt.Sprint(key)] = normalizeStructuredValue(child)
		}
		return normalized
	case []interface{}:
		normalized := make([]interface{}, len(typed))
		for index, child := range typed {
			normalized[index] = normalizeStructuredValue(child)
		}
		return normalized
	default:
		return typed
	}
}
