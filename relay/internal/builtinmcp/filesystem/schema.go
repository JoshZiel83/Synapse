package filesystem

import "github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"

func (s *Server) buildTools() []core.Tool {
	return []core.Tool{
		{
			Name:        "list_allowed_directories",
			Description: "List directories the built-in filesystem server is allowed to access, including read/write scope information.",
			InputSchema: objectSchema(nil, nil),
		},
		{
			Name:        "read_text_file",
			Description: "Read one file as UTF-8 text. For supported PDFs and office files, the server extracts readable text instead of returning binary bytes.",
			InputSchema: objectSchema(map[string]interface{}{
				"path": stringSchema("Absolute path to the file. Relative paths are only allowed when exactly one scoped root exists."),
			}, []string{"path"}),
		},
		{
			Name:        "get_file",
			Description: "Return one regular file as a binary attachment. The relay refuses files larger than the configured max_get_file_size_bytes limit.",
			InputSchema: objectSchema(map[string]interface{}{
				"path": stringSchema("Absolute path to the file. Relative paths are only allowed when exactly one scoped root exists."),
			}, []string{"path"}),
		},
		{
			Name:        "read_multiple_files",
			Description: "Read multiple files as UTF-8 text or extracted document text in one request.",
			InputSchema: objectSchema(map[string]interface{}{
				"paths": stringArraySchema("Absolute file paths to read."),
			}, []string{"paths"}),
		},
		{
			Name:        "write_file",
			Description: s.writeToolDescription("Create or replace a UTF-8 text file."),
			InputSchema: objectSchema(map[string]interface{}{
				"path":    stringSchema("Absolute file path to create or overwrite."),
				"content": stringSchema("UTF-8 text content to write."),
			}, []string{"path", "content"}),
		},
		{
			Name:        "edit_file",
			Description: s.writeToolDescription("Apply one or more exact string replacements to a text file."),
			InputSchema: objectSchema(map[string]interface{}{
				"path": stringSchema("Absolute text file path to edit."),
				"edits": map[string]interface{}{
					"type":        "array",
					"description": "Sequential exact-match replacements.",
					"items": objectSchema(map[string]interface{}{
						"old_text": stringSchema("Text to find."),
						"new_text": stringSchema("Replacement text."),
					}, []string{"old_text", "new_text"}),
				},
			}, []string{"path", "edits"}),
		},
		{
			Name:        "create_directory",
			Description: s.writeToolDescription("Create a directory and any missing parent directories."),
			InputSchema: objectSchema(map[string]interface{}{
				"path": stringSchema("Absolute directory path to create."),
			}, []string{"path"}),
		},
		{
			Name:        "list_directory",
			Description: "List direct children in one directory.",
			InputSchema: objectSchema(map[string]interface{}{
				"path": stringSchema("Absolute directory path to list."),
			}, []string{"path"}),
		},
		{
			Name:        "directory_tree",
			Description: "Return a recursive directory tree rooted at one directory.",
			InputSchema: objectSchema(map[string]interface{}{
				"path": stringSchema("Absolute directory path to expand."),
				"max_depth": map[string]interface{}{
					"type":        "integer",
					"description": "Maximum depth to traverse. Defaults to 4.",
					"minimum":     1,
					"maximum":     16,
				},
			}, []string{"path"}),
		},
		{
			Name:        "move_file",
			Description: s.writeToolDescription("Rename or move a file or directory."),
			InputSchema: objectSchema(map[string]interface{}{
				"source":      stringSchema("Absolute source path."),
				"destination": stringSchema("Absolute destination path."),
			}, []string{"source", "destination"}),
		},
		{
			Name:        "get_file_info",
			Description: "Read basic stat metadata for one file or directory.",
			InputSchema: objectSchema(map[string]interface{}{
				"path": stringSchema("Absolute path to inspect."),
			}, []string{"path"}),
		},
		{
			Name:        "search_files",
			Description: "Search indexed paths and, when enabled, indexed document text. Supports path/content/hybrid search, relevance ranking, paging, and structured filters.",
			InputSchema: objectSchema(map[string]interface{}{
				"query": stringSchema("Search query text."),
				"mode": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"path", "content", "hybrid"},
					"description": "Search paths only, content only, or both. Defaults to hybrid when content indexing is enabled, otherwise path.",
				},
				"path":       stringSchema("Optional absolute path prefix to constrain the search."),
				"roots":      stringArraySchema("Optional root filters. Each item may be a root ID from list_allowed_directories or an absolute root path."),
				"extensions": stringArraySchema("Optional extension or basename filters, for example .go, .md, Dockerfile."),
				"type": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"all", "file", "directory"},
					"description": "Restrict results to files only, directories only, or both. Defaults to all.",
				},
				"access": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"all", "ro", "rw"},
					"description": "Filter by effective access mode. Defaults to all.",
				},
				"parsers": stringArraySchema("Optional parser filters such as text, html, pdf, pdf_ocr, spreadsheet, xls, office_xml, odf, flat_odf, epub, rtf, image_ocr, office_legacy_libreoffice, or office_legacy_ole."),
				"content_indexed": map[string]interface{}{
					"type":        "boolean",
					"description": "Optional filter for whether a file currently has indexed extracted content.",
				},
				"min_size_bytes": map[string]interface{}{
					"type":        "integer",
					"description": "Optional minimum file size in bytes.",
					"minimum":     0,
				},
				"max_size_bytes": map[string]interface{}{
					"type":        "integer",
					"description": "Optional maximum file size in bytes.",
					"minimum":     0,
				},
				"modified_after":  stringSchema("Optional RFC3339 timestamp or YYYY-MM-DD date. Results must be modified at or after this time."),
				"modified_before": stringSchema("Optional RFC3339 timestamp or YYYY-MM-DD date. Results must be modified at or before this time."),
				"limit": map[string]interface{}{
					"type":        "integer",
					"description": "Maximum number of results to return. Defaults to 20.",
					"minimum":     1,
					"maximum":     200,
				},
				"offset": map[string]interface{}{
					"type":        "integer",
					"description": "Skip this many results after sorting. Defaults to 0.",
					"minimum":     0,
					"maximum":     10000,
				},
				"sort_by": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"relevance", "path", "modified_at", "size"},
					"description": "Sort by relevance, path, modification time, or size. Defaults to relevance.",
				},
				"sort_direction": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"asc", "desc"},
					"description": "Sort ascending or descending. Defaults to desc for relevance/modified_at/size, asc for path.",
				},
			}, []string{"query"}),
		},
	}
}

func (s *Server) writeToolDescription(base string) string {
	if !s.cfg.ReadOnly {
		return base
	}
	return base + " Read-only mode is enabled right now, so mutating calls return a user-approval error until the user disables read-only mode or grants write access in the Synapse Relay client."
}

func objectSchema(properties map[string]interface{}, required []string) map[string]interface{} {
	if properties == nil {
		properties = map[string]interface{}{}
	}
	return map[string]interface{}{
		"type":       "object",
		"properties": properties,
		"required":   required,
	}
}

func stringSchema(description string) map[string]interface{} {
	return map[string]interface{}{
		"type":        "string",
		"description": description,
	}
}

func stringArraySchema(description string) map[string]interface{} {
	return map[string]interface{}{
		"type":        "array",
		"description": description,
		"items": map[string]interface{}{
			"type": "string",
		},
	}
}
