package cua

import "strconv"

const defaultRuntimeSessionKey = "__default__"

type displaySnapshot struct {
	Key     string
	Display DisplayInfo
}

type sessionState struct {
	displays []displaySnapshot
	ready    bool
}

func runtimeSessionStateKey(runtimeSessionID string) string {
	if runtimeSessionID == "" {
		return defaultRuntimeSessionKey
	}
	return runtimeSessionID
}

func (s *Server) initializeSessionDisplays(runtimeSessionID string) error {
	displays, err := s.desktop.ListDisplays()
	if err != nil {
		return err
	}

	s.mu.Lock()
	s.sessionStates[runtimeSessionStateKey(runtimeSessionID)] = sessionState{
		displays: snapshotDisplays(displays),
		ready:    true,
	}
	s.mu.Unlock()
	return nil
}

func (s *Server) ensureStableDisplays(runtimeSessionID string) ([]DisplayInfo, bool, error) {
	displays, err := s.desktop.ListDisplays()
	if err != nil {
		return nil, false, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	sessionKey := runtimeSessionStateKey(runtimeSessionID)
	state := s.sessionStates[sessionKey]
	if !state.ready {
		s.sessionStates[sessionKey] = sessionState{
			displays: snapshotDisplays(displays),
			ready:    true,
		}
		return cloneDisplays(displays), false, nil
	}
	if displaySnapshotsEqual(state.displays, displays) {
		return cloneDisplays(displays), false, nil
	}

	s.sessionStates[sessionKey] = sessionState{
		displays: snapshotDisplays(displays),
		ready:    true,
	}
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
