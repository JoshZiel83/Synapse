package cua

import "strconv"

type displaySnapshot struct {
	Key     string
	Display DisplayInfo
}

func (s *Server) initializeSessionDisplays() error {
	displays, err := s.desktop.ListDisplays()
	if err != nil {
		return err
	}

	s.mu.Lock()
	s.sessionDisplays = snapshotDisplays(displays)
	s.sessionReady = true
	s.mu.Unlock()
	return nil
}

func (s *Server) ensureStableDisplays() ([]DisplayInfo, bool, error) {
	displays, err := s.desktop.ListDisplays()
	if err != nil {
		return nil, false, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.sessionReady {
		s.sessionDisplays = snapshotDisplays(displays)
		s.sessionReady = true
		return cloneDisplays(displays), false, nil
	}
	if displaySnapshotsEqual(s.sessionDisplays, displays) {
		return cloneDisplays(displays), false, nil
	}

	s.sessionDisplays = snapshotDisplays(displays)
	return cloneDisplays(displays), true, nil
}

func snapshotDisplays(displays []DisplayInfo) []displaySnapshot {
	result := make([]displaySnapshot, 0, len(displays))
	for _, display := range displays {
		result = append(result, displaySnapshot{
			Key:     displaySnapshotKey(display),
			Display: normalizeDisplaySnapshot(display),
		})
	}
	return result
}

func displaySnapshotsEqual(previous []displaySnapshot, current []DisplayInfo) bool {
	if len(previous) != len(current) {
		return false
	}

	currentByKey := make(map[string]DisplayInfo, len(current))
	for _, display := range current {
		key := displaySnapshotKey(display)
		if _, exists := currentByKey[key]; exists {
			return false
		}
		currentByKey[key] = normalizeDisplaySnapshot(display)
	}

	for _, snapshot := range previous {
		currentDisplay, exists := currentByKey[snapshot.Key]
		if !exists {
			return false
		}
		if snapshot.Display != currentDisplay {
			return false
		}
	}

	return true
}

func displaySnapshotKey(display DisplayInfo) string {
	switch {
	case display.ElectronID != 0:
		return "electron_id:" + strconv.FormatInt(display.ElectronID, 10)
	case display.ID != 0:
		return "id:" + strconv.Itoa(display.ID)
	default:
		return "index:" + strconv.Itoa(display.Index)
	}
}

func normalizeDisplaySnapshot(display DisplayInfo) DisplayInfo {
	display.ContainsMouse = false
	return display
}

func cloneDisplays(displays []DisplayInfo) []DisplayInfo {
	result := make([]DisplayInfo, len(displays))
	copy(result, displays)
	return result
}
