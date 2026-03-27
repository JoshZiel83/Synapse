package filesystem

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	_ "modernc.org/sqlite"
)

type syncRequest struct {
	path      string
	recursive bool
}

type fileRecord struct {
	ID             int64
	RootID         string
	AccessMode     string
	AbsPath        string
	RelPath        string
	Basename       string
	Ext            string
	IsDir          bool
	SizeBytes      int64
	MtimeNS        int64
	Parser         string
	IndexedContent bool
	ContentMtimeNS int64
	ContentSize    int64
	ExtractorKey   string
}

func (s *Server) openIndex() error {
	if err := os.MkdirAll(s.cfg.Index.Dir, 0o755); err != nil {
		return fmt.Errorf("create index dir: %w", err)
	}

	dbPath := filepath.Join(s.cfg.Index.Dir, "filesystem.sqlite")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return fmt.Errorf("open sqlite index: %w", err)
	}

	pragmas := []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA synchronous=NORMAL`,
		`PRAGMA temp_store=MEMORY`,
		`PRAGMA foreign_keys=ON`,
		`PRAGMA busy_timeout=5000`,
	}
	for _, stmt := range pragmas {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return fmt.Errorf("sqlite pragma %q: %w", stmt, err)
		}
	}

	schema := []string{
		`CREATE TABLE IF NOT EXISTS files (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			root_id TEXT NOT NULL,
			access_mode TEXT NOT NULL,
			abs_path TEXT NOT NULL UNIQUE,
			rel_path TEXT NOT NULL,
			basename TEXT NOT NULL,
			ext TEXT NOT NULL,
			is_dir INTEGER NOT NULL,
			size_bytes INTEGER NOT NULL,
			mtime_ns INTEGER NOT NULL,
			parser TEXT NOT NULL DEFAULT '',
			indexed_content INTEGER NOT NULL DEFAULT 0,
			content_mtime_ns INTEGER NOT NULL DEFAULT 0,
			content_size_bytes INTEGER NOT NULL DEFAULT 0,
			extractor_key TEXT NOT NULL DEFAULT '',
			updated_at_ns INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_files_root_path ON files(root_id, abs_path)`,
		`CREATE TABLE IF NOT EXISTS content_chunks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
			chunk_no INTEGER NOT NULL,
			text TEXT NOT NULL,
			UNIQUE(file_id, chunk_no)
		)`,
		`CREATE VIRTUAL TABLE IF NOT EXISTS path_fts USING fts5(abs_path, rel_path, basename, tokenize='trigram')`,
		`CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2')`,
	}
	for _, stmt := range schema {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return fmt.Errorf("sqlite schema init failed: %w", err)
		}
	}
	if err := ensureSQLiteColumn(db, "files", "content_mtime_ns", `ALTER TABLE files ADD COLUMN content_mtime_ns INTEGER NOT NULL DEFAULT 0`); err != nil {
		db.Close()
		return fmt.Errorf("sqlite schema migration failed: %w", err)
	}
	if err := ensureSQLiteColumn(db, "files", "content_size_bytes", `ALTER TABLE files ADD COLUMN content_size_bytes INTEGER NOT NULL DEFAULT 0`); err != nil {
		db.Close()
		return fmt.Errorf("sqlite schema migration failed: %w", err)
	}
	if err := ensureSQLiteColumn(db, "files", "extractor_key", `ALTER TABLE files ADD COLUMN extractor_key TEXT NOT NULL DEFAULT ''`); err != nil {
		db.Close()
		return fmt.Errorf("sqlite schema migration failed: %w", err)
	}

	s.db = db
	return nil
}

func ensureSQLiteColumn(db *sql.DB, table, column, stmt string) error {
	rows, err := db.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name string
		var dataType string
		var notNull int
		var defaultValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &defaultValue, &pk); err != nil {
			return err
		}
		if strings.EqualFold(name, column) {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = db.Exec(stmt)
	return err
}

func (s *Server) startBackgroundSync(ctx context.Context) error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("create fs watcher: %w", err)
	}
	s.watcher = watcher
	s.syncCh = make(chan syncRequest, 128)
	s.watchedDirs = make(map[string]struct{})

	s.bg.Add(2)
	go s.runSyncWorker(ctx)
	go s.runWatchLoop(ctx)

	initialRoots := s.effectiveRoots()
	for _, root := range initialRoots {
		s.enqueueSync(root.Path, true)
	}
	return nil
}

func (s *Server) runSyncWorker(ctx context.Context) {
	defer s.bg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case req := <-s.syncCh:
			if err := s.syncPath(req.path, req.recursive); err != nil {
				log.Printf("filesystem sync error for %s: %v", req.path, err)
			}
		}
	}
}

func (s *Server) runWatchLoop(ctx context.Context) {
	defer s.bg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			s.handleWatchEvent(event)
		case err, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("filesystem watcher error: %v", err)
		}
	}
}

func (s *Server) handleWatchEvent(event fsnotify.Event) {
	path := filepath.Clean(event.Name)
	if _, blocked := s.blockedSystemPath(path); blocked {
		return
	}

	if event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
		s.removeWatchesUnder(path)
	}

	if info, err := os.Stat(path); err == nil {
		if info.IsDir() {
			s.enqueueSync(path, true)
			return
		}
		s.enqueueSync(path, false)
		return
	}

	s.enqueueSync(path, false)
}

func (s *Server) enqueueSync(path string, recursive bool) {
	if path == "" {
		return
	}
	select {
	case s.syncCh <- syncRequest{path: filepath.Clean(path), recursive: recursive}:
	default:
		go func() {
			select {
			case s.syncCh <- syncRequest{path: filepath.Clean(path), recursive: recursive}:
			case <-time.After(500 * time.Millisecond):
			}
		}()
	}
}

func (s *Server) syncPath(target string, recursive bool) error {
	target = filepath.Clean(target)
	if _, blocked := s.blockedSystemPath(target); blocked {
		return nil
	}

	info, err := os.Stat(target)
	if err != nil {
		if os.IsNotExist(err) {
			return s.deleteMissingPath(target)
		}
		return err
	}

	if info.IsDir() && recursive {
		return s.syncDirectoryTree(target)
	}
	return s.syncSinglePath(target, info)
}

func (s *Server) syncDirectoryTree(root string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	seen := make(map[string]struct{})
	err = filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if _, blocked := s.blockedSystemPath(path); blocked {
			if info.IsDir() && path != root {
				return filepath.SkipDir
			}
			return nil
		}
		seen[path] = struct{}{}
		if info.IsDir() {
			if err := s.ensureWatchDir(path); err != nil {
				log.Printf("filesystem watch add failed for %s: %v", path, err)
			}
		}
		return s.upsertFileRecord(tx, path, info)
	})
	if err != nil {
		return err
	}
	if err := s.deleteMissingUnder(tx, root, seen); err != nil {
		return err
	}
	if _, err := tx.Exec(`PRAGMA optimize`); err != nil {
		log.Printf("filesystem sqlite optimize warning: %v", err)
	}
	return tx.Commit()
}

func (s *Server) syncSinglePath(path string, info os.FileInfo) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if info.IsDir() {
		if err := s.ensureWatchDir(path); err != nil {
			log.Printf("filesystem watch add failed for %s: %v", path, err)
		}
	}
	if err := s.upsertFileRecord(tx, path, info); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) deleteMissingPath(path string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.deletePathRecords(tx, path); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) deleteMissingUnder(tx *sql.Tx, prefix string, seen map[string]struct{}) error {
	rows, err := tx.Query(`SELECT abs_path FROM files WHERE abs_path = ? OR abs_path LIKE ?`, prefix, likePrefix(prefix))
	if err != nil {
		return err
	}
	defer rows.Close()

	var toDelete []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return err
		}
		if _, ok := seen[path]; !ok {
			toDelete = append(toDelete, path)
		}
	}
	for _, path := range toDelete {
		if err := s.deletePathRecords(tx, path); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *Server) deletePathRecords(tx *sql.Tx, path string) error {
	var ids []int64
	rows, err := tx.Query(`SELECT id FROM files WHERE abs_path = ? OR abs_path LIKE ?`, path, likePrefix(path))
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()

	for _, id := range ids {
		if err := s.deleteContentForFile(tx, id); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM path_fts WHERE rowid = ?`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM files WHERE id = ?`, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) deleteContentForFile(tx *sql.Tx, fileID int64) error {
	rows, err := tx.Query(`SELECT id FROM content_chunks WHERE file_id = ?`, fileID)
	if err != nil {
		return err
	}
	var chunkIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		chunkIDs = append(chunkIDs, id)
	}
	rows.Close()
	for _, chunkID := range chunkIDs {
		if _, err := tx.Exec(`DELETE FROM content_fts WHERE rowid = ?`, chunkID); err != nil {
			return err
		}
	}
	_, err = tx.Exec(`DELETE FROM content_chunks WHERE file_id = ?`, fileID)
	return err
}

func (s *Server) upsertFileRecord(tx *sql.Tx, path string, info os.FileInfo) error {
	root, ok := s.matchRoot(path)
	if !ok {
		return nil
	}
	relPath, err := filepath.Rel(root.Path, path)
	if err != nil {
		return err
	}
	if relPath == "." {
		relPath = filepath.Base(path)
	}

	record := fileRecord{
		RootID:     root.ID,
		AccessMode: root.Access,
		AbsPath:    path,
		RelPath:    filepath.ToSlash(relPath),
		Basename:   filepath.Base(path),
		Ext:        strings.ToLower(filepath.Ext(path)),
		IsDir:      info.IsDir(),
		SizeBytes:  info.Size(),
		MtimeNS:    info.ModTime().UnixNano(),
	}

	var existing fileRecord
	var existingIsDir int
	var existingIndexedContent int
	row := tx.QueryRow(`SELECT id, root_id, access_mode, rel_path, basename, ext, is_dir, size_bytes, mtime_ns, parser, indexed_content, content_mtime_ns, content_size_bytes, extractor_key
		FROM files WHERE abs_path = ?`, path)
	switch err := row.Scan(
		&existing.ID,
		&existing.RootID,
		&existing.AccessMode,
		&existing.RelPath,
		&existing.Basename,
		&existing.Ext,
		&existingIsDir,
		&existing.SizeBytes,
		&existing.MtimeNS,
		&existing.Parser,
		&existingIndexedContent,
		&existing.ContentMtimeNS,
		&existing.ContentSize,
		&existing.ExtractorKey,
	); err {
	case nil:
		existing.IsDir = existingIsDir != 0
		existing.IndexedContent = existingIndexedContent != 0
	case sql.ErrNoRows:
		existing.ID = 0
	default:
		return err
	}

	shouldIndexContent := !record.IsDir &&
		s.cfg.Index.ContentEnabled &&
		record.SizeBytes <= s.cfg.Index.MaxFileSizeBytes &&
		matchesConfiguredFileType(record.Basename, record.Ext, s.cfg.Index.FileTypes)

	extractorKey := ""
	if shouldIndexContent {
		extractorKey = s.contentExtractorKey(path, info)
		record.ContentMtimeNS = record.MtimeNS
		record.ContentSize = record.SizeBytes
		record.ExtractorKey = extractorKey
	}

	unchanged := existing.ID != 0 &&
		existing.RootID == record.RootID &&
		existing.AccessMode == record.AccessMode &&
		existing.RelPath == record.RelPath &&
		existing.Basename == record.Basename &&
		existing.Ext == record.Ext &&
		existing.IsDir == record.IsDir &&
		existing.SizeBytes == record.SizeBytes &&
		existing.MtimeNS == record.MtimeNS &&
		existing.ContentMtimeNS == record.ContentMtimeNS &&
		existing.ContentSize == record.ContentSize &&
		existing.ExtractorKey == record.ExtractorKey

	if unchanged {
		return nil
	}

	var content string
	var parser string
	if shouldIndexContent {
		content, parser, err = s.extractTextContent(path, info)
		if err != nil {
			log.Printf("filesystem content extraction failed for %s: %v", path, err)
		}
	}
	record.Parser = parser

	nowNS := time.Now().UnixNano()
	if existing.ID == 0 {
		res, err := tx.Exec(`INSERT INTO files (
			root_id, access_mode, abs_path, rel_path, basename, ext, is_dir, size_bytes, mtime_ns, parser, indexed_content, content_mtime_ns, content_size_bytes, extractor_key, updated_at_ns
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			record.RootID, record.AccessMode, record.AbsPath, record.RelPath, record.Basename, record.Ext,
			boolToInt(record.IsDir), record.SizeBytes, record.MtimeNS, record.Parser, boolToInt(strings.TrimSpace(content) != ""),
			record.ContentMtimeNS, record.ContentSize, record.ExtractorKey, nowNS,
		)
		if err != nil {
			return err
		}
		record.ID, err = res.LastInsertId()
		if err != nil {
			return err
		}
	} else {
		record.ID = existing.ID
		if _, err := tx.Exec(`UPDATE files SET
			root_id = ?, access_mode = ?, rel_path = ?, basename = ?, ext = ?, is_dir = ?, size_bytes = ?, mtime_ns = ?, parser = ?, indexed_content = ?, content_mtime_ns = ?, content_size_bytes = ?, extractor_key = ?, updated_at_ns = ?
			WHERE id = ?`,
			record.RootID, record.AccessMode, record.RelPath, record.Basename, record.Ext, boolToInt(record.IsDir),
			record.SizeBytes, record.MtimeNS, record.Parser, boolToInt(strings.TrimSpace(content) != ""),
			record.ContentMtimeNS, record.ContentSize, record.ExtractorKey, nowNS, record.ID,
		); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(`INSERT OR REPLACE INTO path_fts(rowid, abs_path, rel_path, basename) VALUES (?, ?, ?, ?)`,
		record.ID, record.AbsPath, record.RelPath, record.Basename,
	); err != nil {
		return err
	}
	if err := s.deleteContentForFile(tx, record.ID); err != nil {
		return err
	}
	if !record.IsDir && strings.TrimSpace(content) != "" {
		chunks := splitContentIntoChunks(content)
		for index, chunk := range chunks {
			res, err := tx.Exec(`INSERT INTO content_chunks(file_id, chunk_no, text) VALUES (?, ?, ?)`, record.ID, index, chunk)
			if err != nil {
				return err
			}
			chunkID, err := res.LastInsertId()
			if err != nil {
				return err
			}
			if _, err := tx.Exec(`INSERT INTO content_fts(rowid, text) VALUES (?, ?)`, chunkID, chunk); err != nil {
				return err
			}
		}
	}

	return nil
}

func splitContentIntoChunks(content string) []string {
	const maxChunkSize = 4096
	content = strings.TrimSpace(content)
	if content == "" {
		return nil
	}
	if len(content) <= maxChunkSize {
		return []string{content}
	}

	var chunks []string
	lines := strings.Split(content, "\n")
	var builder strings.Builder
	for _, line := range lines {
		if builder.Len()+len(line)+1 > maxChunkSize && builder.Len() > 0 {
			chunks = append(chunks, strings.TrimSpace(builder.String()))
			builder.Reset()
		}
		if builder.Len() > 0 {
			builder.WriteString("\n")
		}
		builder.WriteString(line)
	}
	if builder.Len() > 0 {
		chunks = append(chunks, strings.TrimSpace(builder.String()))
	}
	return chunks
}

func (s *Server) ensureWatchDir(path string) error {
	s.watchMu.Lock()
	defer s.watchMu.Unlock()
	if s.watcher == nil {
		return fmt.Errorf("filesystem watcher is not active")
	}
	if _, exists := s.watchedDirs[path]; exists {
		return nil
	}
	if err := s.watcher.Add(path); err != nil {
		return err
	}
	s.watchedDirs[path] = struct{}{}
	return nil
}

func (s *Server) removeWatchesUnder(prefix string) {
	s.watchMu.Lock()
	defer s.watchMu.Unlock()

	var toRemove []string
	for path := range s.watchedDirs {
		if pathWithinPrefix(path, prefix) {
			toRemove = append(toRemove, path)
		}
	}
	sort.Strings(toRemove)
	for _, path := range toRemove {
		_ = s.watcher.Remove(path)
		delete(s.watchedDirs, path)
	}
}

type searchOptions struct {
	query             string
	mode              string
	prefix            string
	roots             []string
	extensions        []string
	typeFilter        string
	accessFilter      string
	parsers           []string
	contentIndexed    *bool
	minSizeBytes      int64
	maxSizeBytes      int64
	hasModifiedAfter  bool
	hasModifiedBefore bool
	modifiedAfter     time.Time
	modifiedBefore    time.Time
	limit             int
	offset            int
	sortBy            string
	sortDirection     string
}

type searchCandidate struct {
	result       SearchResult
	modifiedNS   int64
	pathScore    float64
	contentScore float64
}

func (s *Server) searchIndex(input SearchQuery) ([]SearchResult, error) {
	options, err := s.compileSearchOptions(input)
	if err != nil {
		return nil, err
	}

	candidateLimit := searchCandidateLimit(options.limit, options.offset)
	merged := make(map[string]*searchCandidate)

	if options.mode == "path" || options.mode == "hybrid" {
		candidates, err := s.searchPathCandidates(options, candidateLimit)
		if err != nil {
			return nil, err
		}
		mergeSearchCandidates(merged, candidates)
	}
	if options.mode == "content" || options.mode == "hybrid" {
		candidates, err := s.searchContentCandidates(options, candidateLimit)
		if err != nil {
			return nil, err
		}
		mergeSearchCandidates(merged, candidates)
	}

	candidates := make([]searchCandidate, 0, len(merged))
	for _, candidate := range merged {
		candidate.result.Score = candidate.pathScore + candidate.contentScore
		switch {
		case candidate.pathScore > 0 && candidate.contentScore > 0:
			candidate.result.MatchMode = "hybrid"
			candidate.result.Score += 120
		case candidate.contentScore > 0:
			candidate.result.MatchMode = "content"
		default:
			candidate.result.MatchMode = "path"
		}
		candidates = append(candidates, *candidate)
	}

	sortSearchCandidates(candidates, options)
	start := options.offset
	if start > len(candidates) {
		start = len(candidates)
	}
	end := start + options.limit
	if end > len(candidates) {
		end = len(candidates)
	}

	results := make([]SearchResult, 0, end-start)
	for _, candidate := range candidates[start:end] {
		results = append(results, candidate.result)
	}
	return results, nil
}

func (s *Server) compileSearchOptions(input SearchQuery) (searchOptions, error) {
	options := searchOptions{
		query:          strings.TrimSpace(input.Query),
		roots:          normalizeSearchFilters(input.Roots),
		extensions:     normalizeSearchFilters(input.Extensions),
		parsers:        normalizeSearchFilters(input.Parsers),
		minSizeBytes:   input.MinSizeBytes,
		maxSizeBytes:   input.MaxSizeBytes,
		contentIndexed: input.ContentIndexed,
		limit:          input.Limit,
		offset:         input.Offset,
	}
	if options.query == "" {
		return options, fmt.Errorf("a non-empty query is required")
	}
	if options.limit <= 0 {
		options.limit = 20
	}
	if options.limit > 200 {
		options.limit = 200
	}
	if options.offset < 0 {
		return options, fmt.Errorf("offset must be greater than or equal to 0")
	}

	switch strings.TrimSpace(input.Mode) {
	case "":
		if s.cfg.Index.ContentEnabled {
			options.mode = "hybrid"
		} else {
			options.mode = "path"
		}
	case "path", "content", "hybrid":
		options.mode = strings.TrimSpace(input.Mode)
	default:
		return options, fmt.Errorf("unsupported search mode %q", input.Mode)
	}
	if !s.cfg.Index.ContentEnabled && options.mode == "content" {
		return options, fmt.Errorf("content indexing is disabled for this filesystem server")
	}
	if !s.cfg.Index.ContentEnabled && options.mode == "hybrid" {
		options.mode = "path"
	}

	switch strings.TrimSpace(input.Type) {
	case "", "all":
		options.typeFilter = "all"
	case "file", "directory":
		options.typeFilter = strings.TrimSpace(input.Type)
	default:
		return options, fmt.Errorf("unsupported type filter %q", input.Type)
	}

	switch strings.TrimSpace(input.Access) {
	case "", "all":
		options.accessFilter = "all"
	case "ro", "rw":
		options.accessFilter = strings.TrimSpace(input.Access)
	default:
		return options, fmt.Errorf("unsupported access filter %q", input.Access)
	}

	switch strings.TrimSpace(input.SortBy) {
	case "", "relevance":
		options.sortBy = "relevance"
	case "path", "modified_at", "size":
		options.sortBy = strings.TrimSpace(input.SortBy)
	default:
		return options, fmt.Errorf("unsupported sort_by value %q", input.SortBy)
	}

	switch strings.TrimSpace(input.SortDirection) {
	case "":
		options.sortDirection = defaultSearchSortDirection(options.sortBy)
	case "asc", "desc":
		options.sortDirection = strings.TrimSpace(input.SortDirection)
	default:
		return options, fmt.Errorf("unsupported sort_direction value %q", input.SortDirection)
	}

	if options.minSizeBytes < 0 || options.maxSizeBytes < 0 {
		return options, fmt.Errorf("size filters must be greater than or equal to 0")
	}
	if options.maxSizeBytes > 0 && options.maxSizeBytes < options.minSizeBytes {
		return options, fmt.Errorf("max_size_bytes must be greater than or equal to min_size_bytes")
	}

	if strings.TrimSpace(input.Path) != "" {
		resolved, err := s.resolvePath("", input.Path, false, false)
		if err != nil {
			return options, err
		}
		options.prefix = resolved.Path
	}
	if strings.TrimSpace(input.ModifiedAfter) != "" {
		parsed, err := parseSearchTime(input.ModifiedAfter)
		if err != nil {
			return options, fmt.Errorf("invalid modified_after value: %w", err)
		}
		options.modifiedAfter = parsed
		options.hasModifiedAfter = true
	}
	if strings.TrimSpace(input.ModifiedBefore) != "" {
		parsed, err := parseSearchTime(input.ModifiedBefore)
		if err != nil {
			return options, fmt.Errorf("invalid modified_before value: %w", err)
		}
		options.modifiedBefore = parsed
		options.hasModifiedBefore = true
	}

	return options, nil
}

func (s *Server) searchPathCandidates(options searchOptions, limit int) ([]searchCandidate, error) {
	results := make([]searchCandidate, 0, limit)
	queryText := normalizeSearchText(options.query)
	prefixPattern := likePrefix(options.prefix)

	if usePathLikeFallback(queryText) {
		pattern := likeContains(queryText)
		rows, err := s.db.Query(`
			SELECT abs_path, root_id, access_mode, rel_path, basename, ext, is_dir, size_bytes, mtime_ns, parser, indexed_content
			FROM files
			WHERE (lower(basename) LIKE ? ESCAPE '\' OR lower(rel_path) LIKE ? ESCAPE '\' OR lower(abs_path) LIKE ? ESCAPE '\')
			  AND (? = '' OR abs_path = ? OR abs_path LIKE ? ESCAPE '\')
			LIMIT ?`,
			pattern, pattern, pattern,
			options.prefix, options.prefix, prefixPattern, limit,
		)
		if err != nil {
			return nil, err
		}
		defer rows.Close()

		for rows.Next() {
			candidate, err := scanSearchCandidate(rows)
			if err != nil {
				return nil, err
			}
			candidate.pathScore = scorePathCandidate(options.query, candidate.result, candidate.modifiedNS, 4)
			if s.matchesSearchFilters(candidate, options) {
				results = append(results, candidate)
			}
		}
		return results, rows.Err()
	}

	fts := ftsQuery(options.query)
	if fts == "" {
		return nil, nil
	}

	rows, err := s.db.Query(`
		SELECT f.abs_path, f.root_id, f.access_mode, f.rel_path, f.basename, f.ext, f.is_dir, f.size_bytes, f.mtime_ns, f.parser, f.indexed_content,
		       bm25(path_fts)
		FROM path_fts
		JOIN files f ON f.id = path_fts.rowid
		WHERE path_fts MATCH ?
		  AND (? = '' OR f.abs_path = ? OR f.abs_path LIKE ? ESCAPE '\')
		ORDER BY bm25(path_fts), f.mtime_ns DESC
		LIMIT ?`,
		fts, options.prefix, options.prefix, prefixPattern, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		candidate, err := scanSearchCandidateWithBM25(rows)
		if err != nil {
			return nil, err
		}
		candidate.pathScore = scorePathCandidate(options.query, candidate.result, candidate.modifiedNS, candidate.pathScore)
		if s.matchesSearchFilters(candidate, options) {
			results = append(results, candidate)
		}
	}
	return results, rows.Err()
}

func (s *Server) searchContentCandidates(options searchOptions, limit int) ([]searchCandidate, error) {
	fts := ftsQuery(options.query)
	if fts == "" {
		return nil, nil
	}

	rows, err := s.db.Query(`
		SELECT f.abs_path, f.root_id, f.access_mode, f.rel_path, f.basename, f.ext, f.is_dir, f.size_bytes, f.mtime_ns, f.parser, f.indexed_content,
		       snippet(content_fts, 0, '[', ']', '...', 18), bm25(content_fts)
		FROM content_fts
		JOIN content_chunks c ON c.id = content_fts.rowid
		JOIN files f ON f.id = c.file_id
		WHERE content_fts MATCH ?
		  AND (? = '' OR f.abs_path = ? OR f.abs_path LIKE ? ESCAPE '\')
		ORDER BY bm25(content_fts), f.mtime_ns DESC, c.chunk_no ASC
		LIMIT ?`,
		fts, options.prefix, options.prefix, likePrefix(options.prefix), limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	resultsByPath := make(map[string]searchCandidate)
	for rows.Next() {
		candidate, err := scanSearchCandidateWithSnippet(rows)
		if err != nil {
			return nil, err
		}
		candidate.contentScore = scoreContentCandidate(options.query, candidate.result, candidate.modifiedNS, candidate.contentScore)
		if !s.matchesSearchFilters(candidate, options) {
			continue
		}

		existing, ok := resultsByPath[candidate.result.Path]
		if !ok || candidate.contentScore > existing.contentScore {
			resultsByPath[candidate.result.Path] = candidate
			continue
		}
		if existing.result.Snippet == "" && candidate.result.Snippet != "" {
			existing.result.Snippet = candidate.result.Snippet
			resultsByPath[candidate.result.Path] = existing
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	results := make([]searchCandidate, 0, len(resultsByPath))
	for _, candidate := range resultsByPath {
		results = append(results, candidate)
	}
	return results, nil
}

func scanSearchCandidate(rows *sql.Rows) (searchCandidate, error) {
	var candidate searchCandidate
	var isDir int
	var indexedContent int
	if err := rows.Scan(
		&candidate.result.Path,
		&candidate.result.RootID,
		&candidate.result.Access,
		&candidate.result.RelPath,
		&candidate.result.Name,
		&candidate.result.Extension,
		&isDir,
		&candidate.result.SizeBytes,
		&candidate.modifiedNS,
		&candidate.result.Parser,
		&indexedContent,
	); err != nil {
		return searchCandidate{}, err
	}
	candidate.result.IsDir = isDir != 0
	candidate.result.IndexedContent = indexedContent != 0
	candidate.result.ModifiedAt = time.Unix(0, candidate.modifiedNS).UTC().Format(time.RFC3339)
	return candidate, nil
}

func scanSearchCandidateWithBM25(rows *sql.Rows) (searchCandidate, error) {
	candidate, err := scanSearchCandidatePrefix(rows)
	if err != nil {
		return searchCandidate{}, err
	}
	return candidate, nil
}

func scanSearchCandidatePrefix(rows *sql.Rows) (searchCandidate, error) {
	var candidate searchCandidate
	var isDir int
	var indexedContent int
	var rawScore float64
	if err := rows.Scan(
		&candidate.result.Path,
		&candidate.result.RootID,
		&candidate.result.Access,
		&candidate.result.RelPath,
		&candidate.result.Name,
		&candidate.result.Extension,
		&isDir,
		&candidate.result.SizeBytes,
		&candidate.modifiedNS,
		&candidate.result.Parser,
		&indexedContent,
		&rawScore,
	); err != nil {
		return searchCandidate{}, err
	}
	candidate.result.IsDir = isDir != 0
	candidate.result.IndexedContent = indexedContent != 0
	candidate.result.ModifiedAt = time.Unix(0, candidate.modifiedNS).UTC().Format(time.RFC3339)
	candidate.pathScore = rawScore
	return candidate, nil
}

func scanSearchCandidateWithSnippet(rows *sql.Rows) (searchCandidate, error) {
	var candidate searchCandidate
	var isDir int
	var indexedContent int
	var rawScore float64
	if err := rows.Scan(
		&candidate.result.Path,
		&candidate.result.RootID,
		&candidate.result.Access,
		&candidate.result.RelPath,
		&candidate.result.Name,
		&candidate.result.Extension,
		&isDir,
		&candidate.result.SizeBytes,
		&candidate.modifiedNS,
		&candidate.result.Parser,
		&indexedContent,
		&candidate.result.Snippet,
		&rawScore,
	); err != nil {
		return searchCandidate{}, err
	}
	candidate.result.IsDir = isDir != 0
	candidate.result.IndexedContent = indexedContent != 0
	candidate.result.ModifiedAt = time.Unix(0, candidate.modifiedNS).UTC().Format(time.RFC3339)
	candidate.contentScore = rawScore
	return candidate, nil
}

func mergeSearchCandidates(target map[string]*searchCandidate, incoming []searchCandidate) {
	for _, candidate := range incoming {
		existing, ok := target[candidate.result.Path]
		if !ok {
			copyCandidate := candidate
			target[candidate.result.Path] = &copyCandidate
			continue
		}
		if candidate.pathScore > existing.pathScore {
			existing.pathScore = candidate.pathScore
		}
		if candidate.contentScore > existing.contentScore {
			existing.contentScore = candidate.contentScore
		}
		if existing.result.Snippet == "" && candidate.result.Snippet != "" {
			existing.result.Snippet = candidate.result.Snippet
		}
		if existing.result.Parser == "" && candidate.result.Parser != "" {
			existing.result.Parser = candidate.result.Parser
		}
		existing.result.IndexedContent = existing.result.IndexedContent || candidate.result.IndexedContent
	}
}

func (s *Server) matchesSearchFilters(candidate searchCandidate, options searchOptions) bool {
	result := candidate.result

	if options.typeFilter == "file" && result.IsDir {
		return false
	}
	if options.typeFilter == "directory" && !result.IsDir {
		return false
	}
	if options.accessFilter != "all" && result.Access != options.accessFilter {
		return false
	}
	if len(options.extensions) > 0 && !matchesConfiguredFileType(result.Name, strings.ToLower(result.Extension), options.extensions) {
		return false
	}
	if len(options.roots) > 0 && !matchesRootFilters(result.Path, result.RootID, options.roots) {
		return false
	}
	if len(options.parsers) > 0 && !containsFold(options.parsers, result.Parser) {
		return false
	}
	if options.contentIndexed != nil && result.IndexedContent != *options.contentIndexed {
		return false
	}
	if options.minSizeBytes > 0 && result.SizeBytes < options.minSizeBytes {
		return false
	}
	if options.maxSizeBytes > 0 && result.SizeBytes > options.maxSizeBytes {
		return false
	}
	modifiedAt := time.Unix(0, candidate.modifiedNS)
	if options.hasModifiedAfter && modifiedAt.Before(options.modifiedAfter) {
		return false
	}
	if options.hasModifiedBefore && modifiedAt.After(options.modifiedBefore) {
		return false
	}
	return true
}

func matchesRootFilters(path, rootID string, filters []string) bool {
	for _, filter := range filters {
		if filter == "" {
			continue
		}
		if strings.EqualFold(filter, rootID) {
			return true
		}
		if filepath.IsAbs(filter) && pathWithinPrefix(path, filter) {
			return true
		}
	}
	return false
}

func normalizeSearchFilters(values []string) []string {
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if filepath.IsAbs(value) {
			normalized = append(normalized, filepath.Clean(value))
			continue
		}
		normalized = append(normalized, strings.ToLower(value))
	}
	return normalized
}

func containsFold(values []string, target string) bool {
	target = strings.ToLower(strings.TrimSpace(target))
	for _, value := range values {
		if strings.ToLower(strings.TrimSpace(value)) == target {
			return true
		}
	}
	return false
}

func scorePathCandidate(query string, result SearchResult, modifiedNS int64, bm25Score float64) float64 {
	query = normalizeSearchText(query)
	if query == "" {
		return 0
	}

	name := strings.ToLower(result.Name)
	relPath := strings.ToLower(result.RelPath)
	fullPath := strings.ToLower(result.Path)
	trimmedName := strings.TrimSuffix(name, strings.ToLower(result.Extension))
	score := 60 / (1 + nonNegativeScore(bm25Score))

	switch {
	case name == query || trimmedName == query:
		score += 900
	case relPath == query || fullPath == query:
		score += 760
	}
	if strings.HasPrefix(name, query) {
		score += 280
	}
	if strings.Contains(name, query) {
		score += 160
	}
	if strings.HasPrefix(relPath, query) {
		score += 110
	}
	if strings.Contains(relPath, query) {
		score += 70
	}
	if !result.IsDir {
		score += 8
	}
	return score + recencyBonus(modifiedNS)
}

func scoreContentCandidate(query string, result SearchResult, modifiedNS int64, bm25Score float64) float64 {
	query = normalizeSearchText(query)
	if query == "" {
		return 0
	}

	score := 85 / (1 + nonNegativeScore(bm25Score))
	if strings.Contains(strings.ToLower(result.Snippet), query) {
		score += 180
	}
	if strings.Contains(strings.ToLower(result.Name), query) {
		score += 40
	}
	return score + recencyBonus(modifiedNS)
}

func recencyBonus(modifiedNS int64) float64 {
	age := time.Since(time.Unix(0, modifiedNS))
	switch {
	case age <= 7*24*time.Hour:
		return 24
	case age <= 30*24*time.Hour:
		return 14
	case age <= 90*24*time.Hour:
		return 6
	default:
		return 0
	}
}

func nonNegativeScore(value float64) float64 {
	if value < 0 {
		return -value
	}
	return value
}

func sortSearchCandidates(candidates []searchCandidate, options searchOptions) {
	ascending := options.sortDirection == "asc"
	sort.Slice(candidates, func(i, j int) bool {
		left := candidates[i]
		right := candidates[j]

		switch options.sortBy {
		case "path":
			if strings.ToLower(left.result.Path) != strings.ToLower(right.result.Path) {
				if ascending {
					return strings.ToLower(left.result.Path) < strings.ToLower(right.result.Path)
				}
				return strings.ToLower(left.result.Path) > strings.ToLower(right.result.Path)
			}
		case "modified_at":
			if left.modifiedNS != right.modifiedNS {
				if ascending {
					return left.modifiedNS < right.modifiedNS
				}
				return left.modifiedNS > right.modifiedNS
			}
		case "size":
			if left.result.SizeBytes != right.result.SizeBytes {
				if ascending {
					return left.result.SizeBytes < right.result.SizeBytes
				}
				return left.result.SizeBytes > right.result.SizeBytes
			}
		default:
			if left.result.Score != right.result.Score {
				if ascending {
					return left.result.Score < right.result.Score
				}
				return left.result.Score > right.result.Score
			}
		}

		if left.modifiedNS != right.modifiedNS {
			return left.modifiedNS > right.modifiedNS
		}
		return strings.ToLower(left.result.Path) < strings.ToLower(right.result.Path)
	})
}

func defaultSearchSortDirection(sortBy string) string {
	if sortBy == "path" {
		return "asc"
	}
	return "desc"
}

func parseSearchTime(value string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339, "2006-01-02"} {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("unsupported time format %q", value)
}

func searchCandidateLimit(limit, offset int) int {
	size := (limit + offset) * 8
	if size < 80 {
		size = 80
	}
	if size > 1200 {
		size = 1200
	}
	return size
}

func normalizeSearchText(query string) string {
	return strings.ToLower(strings.TrimSpace(strings.Join(strings.Fields(query), " ")))
}

func usePathLikeFallback(query string) bool {
	return len([]rune(query)) < 3
}

func likePrefix(prefix string) string {
	if prefix == "" {
		return ""
	}
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(prefix) + `%`
}

func likeContains(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + replacer.Replace(value) + "%"
}

func ftsQuery(input string) string {
	parts := strings.Fields(strings.TrimSpace(input))
	quoted := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.ReplaceAll(part, `"`, " ")
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		quoted = append(quoted, fmt.Sprintf(`"%s"*`, part))
	}
	if len(quoted) == 0 {
		return ""
	}
	return strings.Join(quoted, " AND ")
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func (s *Server) closeIndex() {
	if s.watcher != nil {
		_ = s.watcher.Close()
	}
	if s.db != nil {
		_ = s.db.Close()
	}
}
