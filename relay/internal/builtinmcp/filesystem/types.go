package filesystem

type Config struct {
	StableKey    string
	Name         string
	ReadOnly     bool
	Scope        string
	GlobalAccess string
	Roots        []Root
	Index        IndexConfig
}

type Root struct {
	ID     string
	Path   string
	Access string
}

type IndexConfig struct {
	Dir              string
	ContentEnabled   bool
	FileTypes        []string
	MaxFileSizeBytes int64
	ParsePDF         bool
	ParseOffice      bool
	ParseImages      bool
}

type SearchQuery struct {
	Query          string   `json:"query"`
	Mode           string   `json:"mode,omitempty"`
	Path           string   `json:"path,omitempty"`
	Roots          []string `json:"roots,omitempty"`
	Extensions     []string `json:"extensions,omitempty"`
	Type           string   `json:"type,omitempty"`
	Access         string   `json:"access,omitempty"`
	Parsers        []string `json:"parsers,omitempty"`
	ContentIndexed *bool    `json:"content_indexed,omitempty"`
	MinSizeBytes   int64    `json:"min_size_bytes,omitempty"`
	MaxSizeBytes   int64    `json:"max_size_bytes,omitempty"`
	ModifiedAfter  string   `json:"modified_after,omitempty"`
	ModifiedBefore string   `json:"modified_before,omitempty"`
	Limit          int      `json:"limit,omitempty"`
	Offset         int      `json:"offset,omitempty"`
	SortBy         string   `json:"sort_by,omitempty"`
	SortDirection  string   `json:"sort_direction,omitempty"`
}

type SearchResult struct {
	Path           string  `json:"path"`
	RelPath        string  `json:"rel_path,omitempty"`
	Name           string  `json:"name"`
	Extension      string  `json:"extension,omitempty"`
	RootID         string  `json:"root_id,omitempty"`
	Access         string  `json:"access"`
	IsDir          bool    `json:"is_dir"`
	SizeBytes      int64   `json:"size_bytes"`
	ModifiedAt     string  `json:"modified_at"`
	MatchMode      string  `json:"match_mode"`
	Parser         string  `json:"parser,omitempty"`
	IndexedContent bool    `json:"indexed_content"`
	Score          float64 `json:"score"`
	Snippet        string  `json:"snippet,omitempty"`
}

type AllowedDirectory struct {
	ID     string `json:"id,omitempty"`
	Path   string `json:"path"`
	Access string `json:"access"`
	Scope  string `json:"scope"`
}
