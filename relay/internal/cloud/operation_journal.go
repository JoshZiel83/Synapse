package cloud

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
)

const (
	journalRetention  = 7 * 24 * time.Hour
	journalMaxEntries = 2000
)

type JournalEntry struct {
	OperationID       string               `json:"operationId"`
	InputHash         string               `json:"inputHash"`
	ExposureStableKey string               `json:"exposureStableKey,omitempty"`
	ToolName          string               `json:"toolName,omitempty"`
	Status            string               `json:"status"`
	Result            interface{}          `json:"result,omitempty"`
	Error             *RelayOperationError `json:"error,omitempty"`
	UpdatedAt         string               `json:"updatedAt"`
}

type operationJournalFile struct {
	Entries []JournalEntry `json:"entries"`
}

type OperationJournal struct {
	path    string
	mu      sync.Mutex
	entries map[string]JournalEntry
}

func NewOperationJournal(path string) *OperationJournal {
	if path == "" {
		path = relaypaths.Current().OperationJournalPath
	}

	journal := &OperationJournal{
		path:    path,
		entries: make(map[string]JournalEntry),
	}
	journal.load()
	return journal
}

func (j *OperationJournal) Get(operationID string) (JournalEntry, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()

	entry, ok := j.entries[operationID]
	return cloneJournalEntry(entry), ok
}

func (j *OperationJournal) UpsertPending(operationID, inputHash, exposureStableKey, toolName, status string) {
	j.mu.Lock()
	defer j.mu.Unlock()

	entry := j.entries[operationID]
	entry.OperationID = operationID
	entry.InputHash = inputHash
	entry.ExposureStableKey = exposureStableKey
	entry.ToolName = toolName
	entry.Status = status
	entry.Result = nil
	entry.Error = nil
	entry.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	j.entries[operationID] = entry
	j.saveLocked()
}

func (j *OperationJournal) MarkCompleted(operationID, inputHash, exposureStableKey, toolName string, result interface{}) {
	j.mu.Lock()
	defer j.mu.Unlock()

	j.entries[operationID] = JournalEntry{
		OperationID:       operationID,
		InputHash:         inputHash,
		ExposureStableKey: exposureStableKey,
		ToolName:          toolName,
		Status:            "completed",
		Result:            result,
		UpdatedAt:         time.Now().UTC().Format(time.RFC3339Nano),
	}
	j.saveLocked()
}

func (j *OperationJournal) MarkFailed(operationID, inputHash, exposureStableKey, toolName string, opErr *RelayOperationError) {
	j.mu.Lock()
	defer j.mu.Unlock()

	j.entries[operationID] = JournalEntry{
		OperationID:       operationID,
		InputHash:         inputHash,
		ExposureStableKey: exposureStableKey,
		ToolName:          toolName,
		Status:            "failed",
		Error:             cloneRelayOperationError(opErr),
		UpdatedAt:         time.Now().UTC().Format(time.RFC3339Nano),
	}
	j.saveLocked()
}

func (j *OperationJournal) load() {
	j.mu.Lock()
	defer j.mu.Unlock()

	data, err := os.ReadFile(j.path)
	if err != nil {
		return
	}

	var payload operationJournalFile
	if err := json.Unmarshal(data, &payload); err != nil {
		return
	}

	for _, entry := range payload.Entries {
		if entry.OperationID == "" {
			continue
		}
		j.entries[entry.OperationID] = cloneJournalEntry(entry)
	}
	j.pruneLocked()
}

func (j *OperationJournal) saveLocked() {
	j.pruneLocked()

	if err := os.MkdirAll(filepath.Dir(j.path), 0755); err != nil {
		return
	}

	entries := make([]JournalEntry, 0, len(j.entries))
	for _, entry := range j.entries {
		entries = append(entries, cloneJournalEntry(entry))
	}
	sort.Slice(entries, func(i, k int) bool {
		return entries[i].UpdatedAt > entries[k].UpdatedAt
	})

	data, err := json.MarshalIndent(operationJournalFile{Entries: entries}, "", "  ")
	if err != nil {
		return
	}

	tmpPath := j.path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return
	}
	_ = os.Rename(tmpPath, j.path)
}

func (j *OperationJournal) pruneLocked() {
	if len(j.entries) == 0 {
		return
	}

	cutoff := time.Now().Add(-journalRetention)
	type pair struct {
		id    string
		entry JournalEntry
	}
	items := make([]pair, 0, len(j.entries))
	for id, entry := range j.entries {
		if parsed, err := time.Parse(time.RFC3339Nano, entry.UpdatedAt); err == nil && parsed.Before(cutoff) {
			delete(j.entries, id)
			continue
		}
		items = append(items, pair{id: id, entry: entry})
	}

	if len(items) <= journalMaxEntries {
		return
	}

	sort.Slice(items, func(i, k int) bool {
		return items[i].entry.UpdatedAt > items[k].entry.UpdatedAt
	})

	for _, item := range items[journalMaxEntries:] {
		delete(j.entries, item.id)
	}
}

func cloneJournalEntry(entry JournalEntry) JournalEntry {
	return JournalEntry{
		OperationID:       entry.OperationID,
		InputHash:         entry.InputHash,
		ExposureStableKey: entry.ExposureStableKey,
		ToolName:          entry.ToolName,
		Status:            entry.Status,
		Result:            entry.Result,
		Error:             cloneRelayOperationError(entry.Error),
		UpdatedAt:         entry.UpdatedAt,
	}
}

func cloneRelayOperationError(opErr *RelayOperationError) *RelayOperationError {
	if opErr == nil {
		return nil
	}

	return &RelayOperationError{
		Code:                opErr.Code,
		Message:             opErr.Message,
		Retryable:           opErr.Retryable,
		RequiresReplan:      opErr.RequiresReplan,
		CurrentToolRevision: opErr.CurrentToolRevision,
	}
}
