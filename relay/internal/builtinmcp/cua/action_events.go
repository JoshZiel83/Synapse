package cua

import "fmt"

const unsetHUDCoordinate = -1

func (s *Server) recordHUDAction(state actionHUDState) {
	if s.guard == nil {
		return
	}
	s.guard.RecordAction(state)
}

func (s *Server) recordCaptureAction(runtimeSessionID, action string, detail string) {
	s.recordHUDAction(actionHUDState{
		RuntimeSessionID: runtimeSessionID,
		Action:           action,
		Label:            formatHUDLabel(action, detail),
		DisplayIndex:     unsetHUDCoordinate,
		X:                unsetHUDCoordinate,
		Y:                unsetHUDCoordinate,
		ScreenX:          unsetHUDCoordinate,
		ScreenY:          unsetHUDCoordinate,
		StartX:           unsetHUDCoordinate,
		StartY:           unsetHUDCoordinate,
		EndX:             unsetHUDCoordinate,
		EndY:             unsetHUDCoordinate,
		StartScreenX:     unsetHUDCoordinate,
		StartScreenY:     unsetHUDCoordinate,
		EndScreenX:       unsetHUDCoordinate,
		EndScreenY:       unsetHUDCoordinate,
	})
}

func (s *Server) recordPointerAction(runtimeSessionID, action string, display DisplayInfo, x, y int, detail string) {
	screenX, screenY := displayLocalToScreenPoint(display, x, y)
	s.recordHUDAction(actionHUDState{
		RuntimeSessionID: runtimeSessionID,
		Action:           action,
		Label:            formatHUDLabel(action, detail),
		DisplayIndex:     display.Index,
		X:                x,
		Y:                y,
		ScreenX:          screenX,
		ScreenY:          screenY,
		StartX:           unsetHUDCoordinate,
		StartY:           unsetHUDCoordinate,
		EndX:             unsetHUDCoordinate,
		EndY:             unsetHUDCoordinate,
		StartScreenX:     unsetHUDCoordinate,
		StartScreenY:     unsetHUDCoordinate,
		EndScreenX:       unsetHUDCoordinate,
		EndScreenY:       unsetHUDCoordinate,
	})
}

func (s *Server) recordTextAction(runtimeSessionID string, textLength int) {
	s.recordHUDAction(actionHUDState{
		RuntimeSessionID: runtimeSessionID,
		Action:           "type_text",
		Label:            formatHUDLabel("type_text", fmt.Sprintf("输入文本（%d 字符）", textLength)),
		DisplayIndex:     unsetHUDCoordinate,
		X:                unsetHUDCoordinate,
		Y:                unsetHUDCoordinate,
		ScreenX:          unsetHUDCoordinate,
		ScreenY:          unsetHUDCoordinate,
		StartX:           unsetHUDCoordinate,
		StartY:           unsetHUDCoordinate,
		EndX:             unsetHUDCoordinate,
		EndY:             unsetHUDCoordinate,
		StartScreenX:     unsetHUDCoordinate,
		StartScreenY:     unsetHUDCoordinate,
		EndScreenX:       unsetHUDCoordinate,
		EndScreenY:       unsetHUDCoordinate,
		TextLength:       textLength,
	})
}

func (s *Server) recordKeyAction(runtimeSessionID string, keys []string) {
	keysCopy := append([]string(nil), keys...)
	s.recordHUDAction(actionHUDState{
		RuntimeSessionID: runtimeSessionID,
		Action:           "press_keys",
		Label:            formatHUDLabel("press_keys", normalizeKeySequenceLabel(keysCopy)),
		DisplayIndex:     unsetHUDCoordinate,
		X:                unsetHUDCoordinate,
		Y:                unsetHUDCoordinate,
		ScreenX:          unsetHUDCoordinate,
		ScreenY:          unsetHUDCoordinate,
		StartX:           unsetHUDCoordinate,
		StartY:           unsetHUDCoordinate,
		EndX:             unsetHUDCoordinate,
		EndY:             unsetHUDCoordinate,
		StartScreenX:     unsetHUDCoordinate,
		StartScreenY:     unsetHUDCoordinate,
		EndScreenX:       unsetHUDCoordinate,
		EndScreenY:       unsetHUDCoordinate,
		Keys:             keysCopy,
	})
}

func normalizeKeySequenceLabel(keys []string) string {
	if len(keys) == 0 {
		return ""
	}
	rendered := ""
	for index, key := range keys {
		if index > 0 {
			rendered += " + "
		}
		rendered += key
	}
	return rendered
}
