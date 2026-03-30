package desktopdiag

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/config"
)

const (
	sessionFileName = "gui-session.json"
	crashFileName   = "gui-last-crash.json"
	logFileName     = "gui.log"
	maxLogBackups   = 2
)

var now = time.Now
var defaultBaseDir = config.DefaultDir
var currentBootID = systemBootID

type Logging struct {
	file    *os.File
	LogFile string
	LogsDir string
}

type CrashReport struct {
	SchemaVersion     int    `json:"schemaVersion"`
	SessionID         string `json:"sessionId"`
	Version           string `json:"version,omitempty"`
	PreviousStartedAt string `json:"previousStartedAt,omitempty"`
	DetectedAt        string `json:"detectedAt,omitempty"`
	Summary           string `json:"summary"`
	LogFile           string `json:"logFile"`
	LogsDir           string `json:"logsDir"`
}

type sessionRecord struct {
	SchemaVersion int    `json:"schemaVersion"`
	SessionID     string `json:"sessionId"`
	PID           int    `json:"pid"`
	Version       string `json:"version,omitempty"`
	BootID        string `json:"bootId,omitempty"`
	StartedAt     string `json:"startedAt"`
}

type Manager struct {
	mu          sync.Mutex
	logFile     string
	logsDir     string
	sessionPath string
	crashPath   string
	session     sessionRecord
}

func SetupLogging() (*Logging, error) {
	logsDir := filepath.Join(defaultBaseDir(), "logs")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		return nil, fmt.Errorf("create desktop log dir: %w", err)
	}

	logPath := filepath.Join(logsDir, logFileName)
	if err := rotateLogFiles(logPath, maxLogBackups); err != nil {
		return nil, fmt.Errorf("rotate desktop log file: %w", err)
	}

	handle, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, fmt.Errorf("open desktop log file: %w", err)
	}

	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds | log.LUTC)
	log.SetOutput(io.MultiWriter(os.Stderr, handle))

	return &Logging{
		file:    handle,
		LogFile: logPath,
		LogsDir: logsDir,
	}, nil
}

func (l *Logging) Close() error {
	if l == nil || l.file == nil {
		return nil
	}
	return l.file.Close()
}

func Start(version string) (*Manager, *CrashReport, error) {
	baseDir := defaultBaseDir()
	logsDir := filepath.Join(baseDir, "logs")
	stateDir := filepath.Join(baseDir, "state")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		return nil, nil, fmt.Errorf("create desktop log dir: %w", err)
	}
	if err := os.MkdirAll(stateDir, 0755); err != nil {
		return nil, nil, fmt.Errorf("create desktop state dir: %w", err)
	}

	manager := &Manager{
		logFile:     filepath.Join(logsDir, logFileName),
		logsDir:     logsDir,
		sessionPath: filepath.Join(stateDir, sessionFileName),
		crashPath:   filepath.Join(stateDir, crashFileName),
	}

	report, err := manager.loadCrashReport()
	if err != nil && !os.IsNotExist(err) {
		log.Printf("Warning: failed to load previous crash report: %v", err)
		report = nil
		if removeErr := removeIfExists(manager.crashPath); removeErr != nil {
			log.Printf("Warning: failed to remove corrupt crash report: %v", removeErr)
		}
	}

	bootID, err := currentBootID()
	if err != nil {
		log.Printf("Warning: failed to read boot id for crash detection: %v", err)
		bootID = ""
	}

	if previous, err := manager.loadSession(); err == nil && previous != nil {
		if shouldReportCrash(previous, bootID) {
			report = &CrashReport{
				SchemaVersion:     1,
				SessionID:         previous.SessionID,
				Version:           previous.Version,
				PreviousStartedAt: previous.StartedAt,
				DetectedAt:        now().UTC().Format(time.RFC3339Nano),
				Summary:           "Synapse Relay did not close cleanly last time.",
				LogFile:           manager.logFile,
				LogsDir:           manager.logsDir,
			}
			if writeErr := manager.writeCrashReport(report); writeErr != nil {
				return nil, nil, fmt.Errorf("write crash report: %w", writeErr)
			}
		}
	} else if err != nil && !os.IsNotExist(err) {
		log.Printf("Warning: failed to load previous desktop session marker: %v", err)
	}

	if err := removeIfExists(manager.sessionPath); err != nil {
		return nil, nil, err
	}

	manager.session = sessionRecord{
		SchemaVersion: 1,
		SessionID:     fmt.Sprintf("%d-%d", now().UTC().UnixNano(), os.Getpid()),
		PID:           os.Getpid(),
		Version:       strings.TrimSpace(version),
		BootID:        strings.TrimSpace(bootID),
		StartedAt:     now().UTC().Format(time.RFC3339Nano),
	}
	if err := writeJSONAtomic(manager.sessionPath, &manager.session); err != nil {
		return nil, nil, fmt.Errorf("write desktop session marker: %w", err)
	}

	return manager, report, nil
}

func (m *Manager) LogFilePath() string {
	if m == nil {
		return ""
	}
	return m.logFile
}

func (m *Manager) LogsDirPath() string {
	if m == nil {
		return ""
	}
	return m.logsDir
}

func (m *Manager) MarkClean(string) error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return removeIfExists(m.sessionPath)
}

func (m *Manager) RecordPanic(source string, recovered any, stack []byte) error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	log.Printf("Fatal desktop panic source=%s recovered=%v\n%s", source, recovered, string(stack))
	report := &CrashReport{
		SchemaVersion:     1,
		SessionID:         m.session.SessionID,
		Version:           m.session.Version,
		PreviousStartedAt: m.session.StartedAt,
		DetectedAt:        now().UTC().Format(time.RFC3339Nano),
		Summary:           fmt.Sprintf("Synapse Relay crashed: %v", recovered),
		LogFile:           m.logFile,
		LogsDir:           m.logsDir,
	}
	return m.writeCrashReport(report)
}

func (m *Manager) LoadCrashReport() (*CrashReport, error) {
	if m == nil {
		return nil, nil
	}
	return m.loadCrashReport()
}

func (m *Manager) ClearCrashReport() error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return removeIfExists(m.crashPath)
}

func (m *Manager) loadCrashReport() (*CrashReport, error) {
	data, err := os.ReadFile(m.crashPath)
	if err != nil {
		return nil, err
	}
	var report CrashReport
	if err := json.Unmarshal(data, &report); err != nil {
		return nil, fmt.Errorf("parse crash report: %w", err)
	}
	return &report, nil
}

func (m *Manager) writeCrashReport(report *CrashReport) error {
	return writeJSONAtomic(m.crashPath, report)
}

func (m *Manager) loadSession() (*sessionRecord, error) {
	data, err := os.ReadFile(m.sessionPath)
	if err != nil {
		return nil, err
	}
	var record sessionRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, fmt.Errorf("parse desktop session marker: %w", err)
	}
	return &record, nil
}

func shouldReportCrash(previous *sessionRecord, bootID string) bool {
	if previous == nil {
		return false
	}
	previousBootID := strings.TrimSpace(previous.BootID)
	current := strings.TrimSpace(bootID)
	if previousBootID != "" && current != "" && previousBootID != current {
		return false
	}
	return true
}

func rotateLogFiles(path string, backups int) error {
	if backups < 1 {
		return nil
	}
	for idx := backups; idx >= 1; idx-- {
		source := path
		if idx > 1 {
			source = fmt.Sprintf("%s.%d", path, idx-1)
		}
		target := fmt.Sprintf("%s.%d", path, idx)
		if idx == backups {
			if err := removeIfExists(target); err != nil {
				return err
			}
		}
		if _, err := os.Stat(source); err == nil {
			if err := os.Rename(source, target); err != nil {
				return fmt.Errorf("rotate %s to %s: %w", source, target, err)
			}
		}
	}
	return nil
}

func writeJSONAtomic(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".desktopdiag-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer removeIfExists(tmpPath)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func removeIfExists(path string) error {
	err := os.Remove(path)
	if err == nil || os.IsNotExist(err) {
		return nil
	}
	return err
}
