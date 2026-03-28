package chrome

import (
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

//go:embed catalog_slim.json
var slimCatalogJSON []byte

//go:embed catalog_full.json
var fullCatalogJSON []byte

func loadCatalog(data []byte) ([]core.Tool, error) {
	var raw []struct {
		Name        string      `json:"name"`
		Description string      `json:"description"`
		InputSchema interface{} `json:"inputSchema"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}

	tools := make([]core.Tool, 0, len(raw))
	for _, item := range raw {
		tools = append(tools, core.Tool{
			Name:        item.Name,
			Description: item.Description,
			InputSchema: item.InputSchema,
		})
	}
	return tools, nil
}

func staticCatalog(slim bool) ([]core.Tool, error) {
	if slim {
		tools, err := loadCatalog(slimCatalogJSON)
		if err != nil {
			return nil, fmt.Errorf("load slim chrome catalog: %w", err)
		}
		return tools, nil
	}

	tools, err := loadCatalog(fullCatalogJSON)
	if err != nil {
		return nil, fmt.Errorf("load full chrome catalog: %w", err)
	}
	return tools, nil
}
