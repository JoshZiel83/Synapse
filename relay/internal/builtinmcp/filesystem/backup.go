package filesystem

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

type backupStore struct {
	cfg BackupConfig
	mu  sync.Mutex
}

type backupRecord struct {
	ID           string `json:"id"`
	OriginalPath string `json:"original_path"`
	OriginalKind string `json:"original_kind"`
	Encoding     string `json:"encoding"`
	MimeType     string `json:"mime_type"`
	Operation    string `json:"operation"`
	CreatedAt    string `json:"created_at"`
	SizeBytes    int64  `json:"size_bytes"`
	BlobFile     string `json:"blob_file"`
	SHA256       string `json:"sha256"`
}

type backupResult struct {
	Status     string
	BackupID   string
	Path       string
	Kind       string
	Operation  string
	CreatedAt  string
	SizeBytes  int64
	Reason     string
	MimeType   string
	Restorable bool
}

type backupPayload struct {
	Record backupRecord
	Data   []byte
}

type backupStoreMeta struct {
	PrunedCount int64 `json:"pruned_count"`
}

type backupListResult struct {
	Records     []backupRecord
	Total       int
	UsedBytes   int64
	LimitBytes  int64
	PrunedCount int64
}

func newBackupStore(cfg BackupConfig) *backupStore {
	if strings.TrimSpace(cfg.Dir) == "" {
		return nil
	}
	return &backupStore{cfg: cfg}
}

func (s *backupStore) capture(path, operation string) (backupResult, error) {
	path = filepath.Clean(path)
	if !s.cfg.Enabled {
		return backupResult{
			Status:     "disabled",
			Path:       path,
			Operation:  operation,
			Reason:     "Automatic backups are disabled.",
			Restorable: false,
		}, nil
	}

	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return backupResult{
				Status:     "not_needed",
				Path:       path,
				Operation:  operation,
				Reason:     "The path did not exist before this mutation.",
				Restorable: false,
			}, nil
		}
		return backupResult{}, err
	}

	estimateLimit := maxPositive(s.cfg.MaxFileSizeBytes, s.cfg.MaxTotalSizeBytes)
	if estimateLimit > 0 {
		estimatedSize, err := estimateSnapshotSize(path, info, estimateLimit)
		if err != nil {
			return backupResult{}, err
		}
		if s.cfg.MaxFileSizeBytes > 0 && estimatedSize > s.cfg.MaxFileSizeBytes {
			return backupResult{
				Status:     "skipped",
				Path:       path,
				Kind:       snapshotKindFromInfo(info),
				Operation:  operation,
				SizeBytes:  estimatedSize,
				Reason:     fmt.Sprintf("Snapshot exceeded the configured per-backup limit of %d bytes.", s.cfg.MaxFileSizeBytes),
				Restorable: false,
			}, nil
		}
		if s.cfg.MaxTotalSizeBytes > 0 && estimatedSize > s.cfg.MaxTotalSizeBytes {
			return backupResult{
				Status:     "skipped",
				Path:       path,
				Kind:       snapshotKindFromInfo(info),
				Operation:  operation,
				SizeBytes:  estimatedSize,
				Reason:     fmt.Sprintf("Snapshot exceeded the configured backup storage limit of %d bytes.", s.cfg.MaxTotalSizeBytes),
				Restorable: false,
			}, nil
		}
	}

	kind, encoding, mimeType, data, err := snapshotPath(path, info)
	if err != nil {
		return backupResult{}, err
	}
	sizeBytes := int64(len(data))
	if s.cfg.MaxFileSizeBytes > 0 && sizeBytes > s.cfg.MaxFileSizeBytes {
		return backupResult{
			Status:     "skipped",
			Path:       path,
			Kind:       kind,
			Operation:  operation,
			SizeBytes:  sizeBytes,
			MimeType:   mimeType,
			Reason:     fmt.Sprintf("Snapshot exceeded the configured per-backup limit of %d bytes.", s.cfg.MaxFileSizeBytes),
			Restorable: false,
		}, nil
	}
	if s.cfg.MaxTotalSizeBytes > 0 && sizeBytes > s.cfg.MaxTotalSizeBytes {
		return backupResult{
			Status:     "skipped",
			Path:       path,
			Kind:       kind,
			Operation:  operation,
			SizeBytes:  sizeBytes,
			MimeType:   mimeType,
			Reason:     fmt.Sprintf("Snapshot exceeded the configured backup storage limit of %d bytes.", s.cfg.MaxTotalSizeBytes),
			Restorable: false,
		}, nil
	}

	if err := os.MkdirAll(s.cfg.Dir, 0o755); err != nil {
		return backupResult{}, err
	}

	id, err := newBackupID()
	if err != nil {
		return backupResult{}, err
	}
	createdAt := time.Now().UTC().Format(time.RFC3339)
	sha256Sum := sha256.Sum256(data)
	sha256Hex := hex.EncodeToString(sha256Sum[:])
	blobExt := ".bin"
	if encoding == "zip" {
		blobExt = ".zip"
	}
	record := backupRecord{
		ID:           id,
		OriginalPath: path,
		OriginalKind: kind,
		Encoding:     encoding,
		MimeType:     mimeType,
		Operation:    operation,
		CreatedAt:    createdAt,
		SizeBytes:    sizeBytes,
		BlobFile:     id + blobExt,
		SHA256:       sha256Hex,
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	records, err := s.loadRecordsLocked()
	if err != nil {
		return backupResult{}, err
	}
	if s.cfg.MaxTotalSizeBytes > 0 {
		totalSize := int64(0)
		for _, existing := range records {
			totalSize += existing.SizeBytes
		}
		if totalSize+sizeBytes > s.cfg.MaxTotalSizeBytes {
			if err := s.pruneLocked(records, sizeBytes); err != nil {
				return backupResult{}, err
			}
		}
	}

	blobPath := filepath.Join(s.cfg.Dir, record.BlobFile)
	if err := os.WriteFile(blobPath, data, 0o600); err != nil {
		return backupResult{}, err
	}

	metaPath := filepath.Join(s.cfg.Dir, record.ID+".json")
	metaData, err := json.Marshal(record)
	if err != nil {
		_ = os.Remove(blobPath)
		return backupResult{}, err
	}
	if err := os.WriteFile(metaPath, metaData, 0o600); err != nil {
		_ = os.Remove(blobPath)
		return backupResult{}, err
	}

	return backupResult{
		Status:     "created",
		BackupID:   record.ID,
		Path:       record.OriginalPath,
		Kind:       record.OriginalKind,
		Operation:  record.Operation,
		CreatedAt:  record.CreatedAt,
		SizeBytes:  record.SizeBytes,
		MimeType:   record.MimeType,
		Restorable: true,
	}, nil
}

func (s *backupStore) getByID(id string) (backupPayload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, err := s.loadRecordLocked(id)
	if err != nil {
		return backupPayload{}, err
	}
	data, err := os.ReadFile(filepath.Join(s.cfg.Dir, record.BlobFile))
	if err != nil {
		return backupPayload{}, err
	}
	return backupPayload{Record: record, Data: data}, nil
}

func (s *backupStore) getByPath(path string, offset int) (backupPayload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if offset < 0 {
		offset = 0
	}
	records, err := s.loadRecordsLocked()
	if err != nil {
		return backupPayload{}, err
	}
	cleanPath := filepath.Clean(path)
	filtered := make([]backupRecord, 0)
	for _, record := range records {
		if filepath.Clean(record.OriginalPath) == cleanPath {
			filtered = append(filtered, record)
		}
	}
	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].CreatedAt > filtered[j].CreatedAt
	})
	if offset >= len(filtered) {
		return backupPayload{}, os.ErrNotExist
	}
	record := filtered[offset]
	data, err := os.ReadFile(filepath.Join(s.cfg.Dir, record.BlobFile))
	if err != nil {
		return backupPayload{}, err
	}
	return backupPayload{Record: record, Data: data}, nil
}

func (s *backupStore) list(path, operation string) (backupListResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	records, err := s.loadRecordsLocked()
	if err != nil {
		return backupListResult{}, err
	}
	meta, err := s.loadMetaLocked()
	if err != nil {
		return backupListResult{}, err
	}

	cleanPath := filepath.Clean(strings.TrimSpace(path))
	operation = strings.TrimSpace(strings.ToLower(operation))
	filtered := make([]backupRecord, 0, len(records))
	usedBytes := int64(0)
	for _, record := range records {
		usedBytes += record.SizeBytes
		if cleanPath != "" && filepath.Clean(record.OriginalPath) != cleanPath {
			continue
		}
		if operation != "" && strings.TrimSpace(strings.ToLower(record.Operation)) != operation {
			continue
		}
		filtered = append(filtered, record)
	}
	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].CreatedAt > filtered[j].CreatedAt
	})

	return backupListResult{
		Records:     filtered,
		Total:       len(filtered),
		UsedBytes:   usedBytes,
		LimitBytes:  s.cfg.MaxTotalSizeBytes,
		PrunedCount: meta.PrunedCount,
	}, nil
}

func (s *backupStore) restore(payload backupPayload, targetPath string) error {
	if err := os.RemoveAll(targetPath); err != nil {
		return err
	}
	switch payload.Record.Encoding {
	case "raw":
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return err
		}
		return os.WriteFile(targetPath, payload.Data, 0o644)
	case "zip":
		if err := os.MkdirAll(targetPath, 0o755); err != nil {
			return err
		}
		return unzipSnapshot(payload.Data, targetPath)
	default:
		return fmt.Errorf("unsupported backup encoding %q", payload.Record.Encoding)
	}
}

func (s *backupStore) loadRecordLocked(id string) (backupRecord, error) {
	data, err := os.ReadFile(filepath.Join(s.cfg.Dir, id+".json"))
	if err != nil {
		return backupRecord{}, err
	}
	var record backupRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return backupRecord{}, err
	}
	return record, nil
}

func (s *backupStore) loadRecordsLocked() ([]backupRecord, error) {
	entries, err := os.ReadDir(s.cfg.Dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	records := make([]backupRecord, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" || entry.Name() == "store_meta.json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.cfg.Dir, entry.Name()))
		if err != nil {
			return nil, err
		}
		var record backupRecord
		if err := json.Unmarshal(data, &record); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool {
		return records[i].CreatedAt < records[j].CreatedAt
	})
	return records, nil
}

func (s *backupStore) loadMetaLocked() (backupStoreMeta, error) {
	data, err := os.ReadFile(filepath.Join(s.cfg.Dir, "store_meta.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return backupStoreMeta{}, nil
		}
		return backupStoreMeta{}, err
	}
	var meta backupStoreMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return backupStoreMeta{}, err
	}
	return meta, nil
}

func (s *backupStore) saveMetaLocked(meta backupStoreMeta) error {
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.cfg.Dir, "store_meta.json"), data, 0o600)
}

func (s *backupStore) pruneLocked(records []backupRecord, incomingSize int64) error {
	if s.cfg.MaxTotalSizeBytes <= 0 {
		return nil
	}
	totalSize := int64(0)
	for _, record := range records {
		totalSize += record.SizeBytes
	}
	if totalSize+incomingSize <= s.cfg.MaxTotalSizeBytes {
		return nil
	}
	meta, err := s.loadMetaLocked()
	if err != nil {
		return err
	}
	for _, record := range records {
		if totalSize+incomingSize <= s.cfg.MaxTotalSizeBytes {
			return s.saveMetaLocked(meta)
		}
		if err := os.Remove(filepath.Join(s.cfg.Dir, record.ID+".json")); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := os.Remove(filepath.Join(s.cfg.Dir, record.BlobFile)); err != nil && !os.IsNotExist(err) {
			return err
		}
		totalSize -= record.SizeBytes
		meta.PrunedCount++
	}
	return s.saveMetaLocked(meta)
}

func snapshotPath(path string, info os.FileInfo) (kind, encoding, mimeType string, data []byte, err error) {
	if info.IsDir() {
		zipped, zipErr := zipDirectorySnapshot(path)
		if zipErr != nil {
			return "", "", "", nil, zipErr
		}
		return "directory", "zip", "application/zip", zipped, nil
	}
	raw, readErr := os.ReadFile(path)
	if readErr != nil {
		return "", "", "", nil, readErr
	}
	return "file", "raw", detectFileMimeType(path, raw), raw, nil
}

func estimateSnapshotSize(path string, info os.FileInfo, limit int64) (int64, error) {
	if !info.IsDir() {
		return info.Size(), nil
	}
	total := int64(0)
	err := filepath.Walk(path, func(current string, currentInfo os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if currentInfo.IsDir() {
			return nil
		}
		total += currentInfo.Size()
		if limit > 0 && total > limit {
			return io.EOF
		}
		return nil
	})
	if err == io.EOF {
		return total, nil
	}
	return total, err
}

func zipDirectorySnapshot(path string) ([]byte, error) {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	err := filepath.Walk(path, func(current string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if current == path {
			return nil
		}
		rel, err := filepath.Rel(path, current)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if info.IsDir() {
			_, err = writer.Create(rel + "/")
			return err
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = rel
		header.Method = zip.Deflate
		entryWriter, err := writer.CreateHeader(header)
		if err != nil {
			return err
		}
		handle, err := os.Open(current)
		if err != nil {
			return err
		}
		_, err = io.Copy(entryWriter, handle)
		closeErr := handle.Close()
		if err != nil {
			return err
		}
		return closeErr
	})
	if err != nil {
		_ = writer.Close()
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func unzipSnapshot(data []byte, targetPath string) error {
	readerAt := bytes.NewReader(data)
	reader, err := zip.NewReader(readerAt, int64(len(data)))
	if err != nil {
		return err
	}
	for _, file := range reader.File {
		destination := filepath.Join(targetPath, filepath.FromSlash(file.Name))
		if !pathWithinPrefix(normalizePathForMatch(destination), normalizePathForMatch(targetPath)) {
			return fmt.Errorf("backup entry %q resolves outside the target path", file.Name)
		}
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(destination, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
			return err
		}
		source, err := file.Open()
		if err != nil {
			return err
		}
		payload, err := io.ReadAll(source)
		source.Close()
		if err != nil {
			return err
		}
		if err := os.WriteFile(destination, payload, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func newBackupID() (string, error) {
	var randomBytes [8]byte
	if _, err := rand.Read(randomBytes[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d_%s", time.Now().UTC().UnixNano(), hex.EncodeToString(randomBytes[:])), nil
}

func snapshotKindFromInfo(info os.FileInfo) string {
	if info.IsDir() {
		return "directory"
	}
	return "file"
}

func maxPositive(values ...int64) int64 {
	maxValue := int64(0)
	for _, value := range values {
		if value > maxValue {
			maxValue = value
		}
	}
	return maxValue
}

func (r backupResult) structured() map[string]interface{} {
	result := map[string]interface{}{
		"status":      r.Status,
		"path":        r.Path,
		"operation":   r.Operation,
		"restorable":  r.Restorable,
		"size_bytes":  r.SizeBytes,
		"mime_type":   r.MimeType,
		"backup_id":   r.BackupID,
		"kind":        r.Kind,
		"created_at":  r.CreatedAt,
		"skip_reason": r.Reason,
	}
	for key, value := range result {
		switch typed := value.(type) {
		case string:
			if strings.TrimSpace(typed) == "" {
				delete(result, key)
			}
		case int64:
			if typed == 0 {
				delete(result, key)
			}
		}
	}
	return result
}

func attachBackupResults(structured map[string]interface{}, backups []backupResult) map[string]interface{} {
	if structured == nil {
		structured = map[string]interface{}{}
	}
	items := make([]map[string]interface{}, 0, len(backups))
	for _, backup := range backups {
		items = append(items, backup.structured())
	}
	structured["backups"] = items
	return structured
}

func backupSummaryText(backups []backupResult) string {
	if len(backups) == 0 {
		return ""
	}
	parts := make([]string, 0, len(backups))
	for _, backup := range backups {
		switch backup.Status {
		case "created":
			parts = append(parts, fmt.Sprintf("created backup %s for %s", backup.BackupID, backup.Path))
		case "disabled":
			parts = append(parts, fmt.Sprintf("backup disabled for %s", backup.Path))
		case "not_needed":
			parts = append(parts, fmt.Sprintf("no prior content to back up for %s", backup.Path))
		case "skipped":
			parts = append(parts, fmt.Sprintf("backup skipped for %s: %s", backup.Path, backup.Reason))
		default:
			parts = append(parts, fmt.Sprintf("backup %s for %s", backup.Status, backup.Path))
		}
	}
	return " Backup status: " + strings.Join(parts, "; ")
}

func backupPayloadResult(payload backupPayload) core.CallResult {
	structured := map[string]interface{}{
		"backup_id":      payload.Record.ID,
		"path":           payload.Record.OriginalPath,
		"kind":           payload.Record.OriginalKind,
		"encoding":       payload.Record.Encoding,
		"mime_type":      payload.Record.MimeType,
		"operation":      payload.Record.Operation,
		"created_at":     payload.Record.CreatedAt,
		"size_bytes":     payload.Record.SizeBytes,
		"sha256":         payload.Record.SHA256,
		"restorable":     true,
		"original_path":  payload.Record.OriginalPath,
		"original_kind":  payload.Record.OriginalKind,
		"backup_blob_id": payload.Record.BlobFile,
	}
	content := []interface{}{
		core.Text(fmt.Sprintf("Retrieved backup %s for %q.", payload.Record.ID, payload.Record.OriginalPath)),
	}
	if payload.Record.Encoding == "raw" && looksLikeText(payload.Record.OriginalPath, payload.Data) {
		preview, totalLines, returnedLines, truncated := sliceTextByLine(string(payload.Data), 0, 200)
		content = append(content, core.Text(preview))
		structured["preview_total_lines"] = totalLines
		structured["preview_returned_lines"] = returnedLines
		structured["preview_truncated_lines"] = truncated
	}
	metadata := map[string]interface{}{
		"backupId":       payload.Record.ID,
		"originalPath":   payload.Record.OriginalPath,
		"operation":      payload.Record.Operation,
		"createdAt":      payload.Record.CreatedAt,
		"sha256":         payload.Record.SHA256,
		"sizeBytes":      payload.Record.SizeBytes,
		"originalKind":   payload.Record.OriginalKind,
		"encoding":       payload.Record.Encoding,
		"restorable":     true,
		"originalMime":   payload.Record.MimeType,
		"backupBlobFile": payload.Record.BlobFile,
	}
	name := filepath.Base(payload.Record.OriginalPath)
	if payload.Record.Encoding == "zip" {
		name += ".backup.zip"
	} else {
		name += ".backup"
	}
	content = append(content, core.BinaryResource(name, payload.Record.MimeType, base64.StdEncoding.EncodeToString(payload.Data), metadata))
	return core.CallResult{
		Content:           content,
		StructuredContent: structured,
	}
}

func textResultWithBackups(text string, structured map[string]interface{}, backups []backupResult) core.CallResult {
	return textResult(text+backupSummaryText(backups), attachBackupResults(structured, backups))
}
