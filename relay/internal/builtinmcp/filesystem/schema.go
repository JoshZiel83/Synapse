package filesystem

import "github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"

func (s *Server) buildTools() []core.Tool {
	return []core.Tool{
		{
			Name:        "ListAllowedDirectories",
			Description: "Lists the directories this filesystem server can currently access, including effective read and write scope. Call this first when you need to understand which roots are available or which root IDs to pass to SearchFiles.",
			InputSchema: objectSchema(nil, nil),
		},
		{
			Name:        "View",
			Description: "Reads extracted text from one file. Prefer this for inspection before editing. Supports ordinary text files plus parsed PDFs, Office documents, HTML, EPUB, RTF, SVG, and image OCR when enabled. file_path must be an absolute path. By default it returns up to 2000 lines from the start of the extracted text. Use offset and limit for long files. Lines longer than 2000 characters are truncated. Use GetFile when you need the original file bytes instead of extracted text.",
			InputSchema: objectSchema(map[string]interface{}{
				"file_path": stringSchema("The absolute path to the file to read."),
				"offset": map[string]interface{}{
					"type":        "integer",
					"description": "Optional line offset to start reading from.",
					"minimum":     0,
				},
				"limit": map[string]interface{}{
					"type":        "integer",
					"description": "Optional number of lines to read. Defaults to 2000.",
					"minimum":     1,
					"maximum":     2000,
				},
			}, []string{"file_path"}),
		},
		{
			Name:        "ViewMany",
			Description: "Reads extracted text from multiple files in one call. Prefer this when you need to inspect several related files together before deciding what to edit or open fully. Supports the same extracted-text formats as View. Every file_path must be an absolute path. Each item can optionally set offset and limit for long files. Use GetFile when you need original file bytes instead of extracted text.",
			InputSchema: objectSchema(map[string]interface{}{
				"files": map[string]interface{}{
					"type":        "array",
					"description": "The files to read.",
					"minItems":    1,
					"maxItems":    50,
					"items": objectSchema(map[string]interface{}{
						"file_path": stringSchema("The absolute path to the file to read."),
						"offset": map[string]interface{}{
							"type":        "integer",
							"description": "Optional line offset to start reading from.",
							"minimum":     0,
						},
						"limit": map[string]interface{}{
							"type":        "integer",
							"description": "Optional number of lines to read. Defaults to 2000.",
							"minimum":     1,
							"maximum":     2000,
						},
					}, []string{"file_path"}),
				},
			}, []string{"files"}),
		},
		{
			Name:        "GetFile",
			Description: "Returns one regular file as a binary attachment. Prefer View or ViewMany for text inspection and partial reads, and use GetFile when you need the original file bytes or a format that extracted text would lose. file_path must be an absolute path. The relay refuses files larger than the configured max_get_file_size_bytes limit.",
			InputSchema: objectSchema(map[string]interface{}{
				"file_path": stringSchema("The absolute path to the file to return."),
			}, []string{"file_path"}),
		},
		{
			Name:        "Replace",
			Description: s.writeToolDescription("Writes UTF-8 text to a file, replacing the entire file contents. Prefer Edit for small targeted changes and Patch for coordinated multi-file edits. file_path must be an absolute path and the parent directory must already exist."),
			InputSchema: objectSchema(map[string]interface{}{
				"file_path": stringSchema("The absolute path to the file to write."),
				"content":   stringSchema("UTF-8 text content to write."),
			}, []string{"file_path", "content"}),
		},
		{
			Name:        "Edit",
			Description: s.writeToolDescription("Replaces exactly one unique occurrence of old_string in a UTF-8 text file. Prefer this for small surgical edits after reading the file. Include enough surrounding context to make old_string unique. file_path must be an absolute path. Use an empty old_string only when creating a brand new file in an existing directory."),
			InputSchema: objectSchema(map[string]interface{}{
				"file_path":  stringSchema("The absolute path to the file to modify."),
				"old_string": stringSchema("The exact text to replace. Must match exactly once unless the file is being created."),
				"new_string": stringSchema("The replacement text."),
			}, []string{"file_path", "old_string", "new_string"}),
		},
		{
			Name:        "Patch",
			Description: s.writeToolDescription("Applies a batch of exact text edits across one or more UTF-8 text files. Prefer this when several related edits should succeed or fail together. All operations are validated before any file is written, so the patch fails atomically if any replacement is ambiguous or invalid."),
			InputSchema: objectSchema(map[string]interface{}{
				"operations": map[string]interface{}{
					"type":        "array",
					"description": "The ordered list of exact text replacements to apply.",
					"minItems":    1,
					"maxItems":    200,
					"items": objectSchema(map[string]interface{}{
						"file_path":  stringSchema("The absolute path to the file to modify."),
						"old_string": stringSchema("The exact text to replace. Use an empty string only when creating a brand new file."),
						"new_string": stringSchema("The replacement text."),
					}, []string{"file_path", "old_string", "new_string"}),
				},
			}, []string{"operations"}),
		},
		{
			Name:        "UpdateStructuredData",
			Description: s.writeToolDescription("Updates structured documents such as JSON, YAML, or TOML using path-based set and delete operations. Prefer this for value-level data edits when formatting, comments, and key ordering do not need to be preserved. file_path must be an absolute path. Formatting, comments, and key ordering are not preserved."),
			InputSchema: objectSchema(map[string]interface{}{
				"file_path": stringSchema("The absolute path to the structured data file to update."),
				"format": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"json", "yaml", "yml", "toml"},
					"description": "Optional explicit format. If omitted, the format is inferred from the file extension.",
				},
				"updates": map[string]interface{}{
					"type":        "array",
					"description": "The ordered path-based updates to apply.",
					"minItems":    1,
					"maxItems":    200,
					"items": objectSchema(map[string]interface{}{
						"path": stringSchema("A dotted path such as scripts.build, compiler.options.strict, or services[0].name."),
						"action": map[string]interface{}{
							"type":        "string",
							"enum":        []string{"set", "delete"},
							"description": "Whether to set or delete the target path. Defaults to set.",
						},
						"value": map[string]interface{}{
							"description": "The value to write for set operations.",
						},
					}, []string{"path"}),
				},
			}, []string{"file_path", "updates"}),
		},
		{
			Name:        "CreateDirectory",
			Description: s.writeToolDescription("Creates a directory and any missing parent directories. directory_path must be an absolute path."),
			InputSchema: objectSchema(map[string]interface{}{
				"directory_path": stringSchema("The absolute path to the directory to create."),
			}, []string{"directory_path"}),
		},
		{
			Name:        "LS",
			Description: "Lists files and directories in one directory. Use this when you already know the directory you want to inspect. directory_path must be an absolute path. Supports paging, sorting, and filename filtering. Prefer GlobTool for filename or path pattern searches, GrepTool for regex content searches, and SearchFiles for indexed broad discovery.",
			InputSchema: objectSchema(map[string]interface{}{
				"directory_path": stringSchema("The absolute path to the directory to list."),
				"offset": map[string]interface{}{
					"type":        "integer",
					"description": "Skip this many entries after sorting. Defaults to 0.",
					"minimum":     0,
				},
				"limit": map[string]interface{}{
					"type":        "integer",
					"description": "Maximum number of entries to return. Defaults to 200.",
					"minimum":     1,
					"maximum":     1000,
				},
				"sort_by": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"name", "modified_at", "size", "type"},
					"description": "How to sort results. Defaults to name.",
				},
				"sort_direction": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"asc", "desc"},
					"description": "Sort ascending or descending.",
				},
				"name_contains": stringSchema("Optional case-insensitive filename filter."),
				"entry_type": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"all", "file", "directory"},
					"description": "Restrict results to files, directories, or both.",
				},
			}, []string{"directory_path"}),
		},
		{
			Name:        "DirectoryTree",
			Description: "Returns a recursive directory tree rooted at one directory. Use this for a quick structure overview before narrower reads or searches. directory_path must be an absolute path.",
			InputSchema: objectSchema(map[string]interface{}{
				"directory_path": stringSchema("The absolute path to the directory to expand."),
				"max_depth": map[string]interface{}{
					"type":        "integer",
					"description": "Maximum depth to traverse. Defaults to 4.",
					"minimum":     1,
					"maximum":     16,
				},
			}, []string{"directory_path"}),
		},
		{
			Name:        "Move",
			Description: s.writeToolDescription("Moves or renames a file or directory. source_path and destination_path must be absolute paths."),
			InputSchema: objectSchema(map[string]interface{}{
				"source_path":      stringSchema("The absolute source path."),
				"destination_path": stringSchema("The absolute destination path."),
			}, []string{"source_path", "destination_path"}),
		},
		{
			Name:        "Copy",
			Description: s.writeToolDescription("Copies a file or directory to a new absolute destination_path. Set recursive to copy directories. Set overwrite to replace an existing destination after backing it up first when backups are enabled."),
			InputSchema: objectSchema(map[string]interface{}{
				"source_path":      stringSchema("The absolute source path to copy."),
				"destination_path": stringSchema("The absolute destination path to write."),
				"recursive": map[string]interface{}{
					"type":        "boolean",
					"description": "Required for directory copies.",
				},
				"overwrite": map[string]interface{}{
					"type":        "boolean",
					"description": "Whether to replace an existing destination path.",
				},
			}, []string{"source_path", "destination_path"}),
		},
		{
			Name:        "Delete",
			Description: s.writeToolDescription("Deletes one file or directory. path must be an absolute path. Set recursive to delete directories. When automatic backups are enabled, the previous contents are captured before deletion when they fit within the configured limits."),
			InputSchema: objectSchema(map[string]interface{}{
				"path": stringSchema("The absolute path to delete."),
				"recursive": map[string]interface{}{
					"type":        "boolean",
					"description": "Required for deleting directories.",
				},
			}, []string{"path"}),
		},
		{
			Name:        "Stat",
			Description: "Returns basic metadata for one file or directory. path must be an absolute path.",
			InputSchema: objectSchema(map[string]interface{}{
				"path": stringSchema("The absolute path to inspect."),
			}, []string{"path"}),
		},
		{
			Name:        "GlobTool",
			Description: "Finds files by glob pattern. Prefer this over LS when you already know the filename or path pattern you want, and prefer it over shell find for filesystem discovery. Supports patterns like \"**/*.js\" or \"src/**/*.ts\" and returns matches sorted by modification time. Use GrepTool for content regex searches and SearchFiles for indexed broad discovery.",
			InputSchema: objectSchema(map[string]interface{}{
				"pattern": stringSchema("The glob pattern to match files against."),
				"path":    stringSchema("The directory to search in. Defaults to the current working directory."),
				"exclude": stringArraySchema("Optional glob patterns to exclude from the search."),
				"respect_gitignore": map[string]interface{}{
					"type":        "boolean",
					"description": "Whether to honor the search root's .gitignore file. Defaults to false.",
				},
			}, []string{"pattern"}),
		},
		{
			Name:        "GrepTool",
			Description: "Searches file contents with a regular expression and returns matching locations sorted by file modification time. Prefer this over shell grep when you need up-to-date regex search results. Supports full regex syntax, optional include filtering such as \"*.js\" or \"*.{ts,tsx}\", and optional context lines around each hit. Use GlobTool for filename or path searches and SearchFiles for indexed broad discovery.",
			InputSchema: objectSchema(map[string]interface{}{
				"pattern": stringSchema("The regular expression pattern to search for in file contents."),
				"path":    stringSchema("The directory to search in. Defaults to the current working directory."),
				"include": stringSchema("Optional file pattern to include in the search, for example *.js or *.{ts,tsx}."),
				"exclude": stringArraySchema("Optional glob patterns to exclude from the search."),
				"respect_gitignore": map[string]interface{}{
					"type":        "boolean",
					"description": "Whether to honor the search root's .gitignore file. Defaults to false.",
				},
				"max_matches": map[string]interface{}{
					"type":        "integer",
					"description": "Maximum number of matching locations to return across all files. Defaults to 50.",
					"minimum":     1,
					"maximum":     500,
				},
				"context_before": map[string]interface{}{
					"type":        "integer",
					"description": "Number of context lines to include before each match. Defaults to 0.",
					"minimum":     0,
					"maximum":     20,
				},
				"context_after": map[string]interface{}{
					"type":        "integer",
					"description": "Number of context lines to include after each match. Defaults to 0.",
					"minimum":     0,
					"maximum":     20,
				},
			}, []string{"pattern"}),
		},
		{
			Name:        "SearchFiles",
			Description: "Searches indexed file paths and, when enabled, indexed extracted text content. Prefer this for broad discovery across large roots when slight index lag is acceptable. Use GrepTool for exact up-to-date regex search and View or ViewMany to inspect chosen files. Supports path, content, or hybrid search with paging, sorting, and structured filters. SearchFiles uses a background index, so very recent filesystem changes might not appear immediately.",
			InputSchema: objectSchema(map[string]interface{}{
				"query": stringSchema("Search query text."),
				"mode": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"path", "content", "hybrid"},
					"description": "Search paths only, content only, or both. Defaults to hybrid when content indexing is enabled, otherwise path.",
				},
				"path":       stringSchema("Optional absolute path prefix to constrain the search."),
				"roots":      stringArraySchema("Optional root filters. Each item may be a root ID from ListAllowedDirectories or an absolute root path."),
				"exclude":    stringArraySchema("Optional glob patterns to exclude from the search."),
				"extensions": stringArraySchema("Optional extension or basename filters, for example .go, .md, Dockerfile."),
				"entry_type": map[string]interface{}{
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
				"respect_gitignore": map[string]interface{}{
					"type":        "boolean",
					"description": "Whether to honor the search root's .gitignore file. Defaults to false.",
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
		{
			Name:        "ListBackups",
			Description: "Lists automatic backups with paging and optional path or operation filters. When path is provided it must be an absolute path. Results are sorted newest first and include current backup storage usage.",
			InputSchema: objectSchema(map[string]interface{}{
				"path":      stringSchema("Optional absolute original path to filter backups by."),
				"operation": stringSchema("Optional operation filter such as replace, edit, patch, move, copy, delete, restore, or update_structured_data."),
				"offset": map[string]interface{}{
					"type":        "integer",
					"description": "Skip this many backups after sorting newest first. Defaults to 0.",
					"minimum":     0,
				},
				"limit": map[string]interface{}{
					"type":        "integer",
					"description": "Maximum number of backups to return. Defaults to 50.",
					"minimum":     1,
					"maximum":     500,
				},
			}, nil),
		},
		{
			Name:        "GetBackup",
			Description: "Retrieves one automatic backup snapshot by backup_id or by the original absolute path plus an offset. Use this to inspect the previous contents captured before a mutating tool changed or deleted a path.",
			InputSchema: objectSchema(map[string]interface{}{
				"backup_id": stringSchema("The backup ID to retrieve."),
				"path":      stringSchema("The original absolute path to look up backups for."),
				"offset": map[string]interface{}{
					"type":        "integer",
					"description": "When using path instead of backup_id, skip this many newer backups. Defaults to 0.",
					"minimum":     0,
				},
			}, nil),
		},
		{
			Name:        "RestoreBackup",
			Description: s.writeToolDescription("Restores a previously captured automatic backup. backup_id is required. If target_path is omitted, the backup is restored to its original absolute path. The current target is backed up first when automatic backups are enabled and the snapshot fits within the configured limits."),
			InputSchema: objectSchema(map[string]interface{}{
				"backup_id":   stringSchema("The backup ID to restore."),
				"target_path": stringSchema("Optional absolute path to restore into instead of the original path."),
			}, []string{"backup_id"}),
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
		"type":                 "object",
		"properties":           properties,
		"required":             required,
		"additionalProperties": false,
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
