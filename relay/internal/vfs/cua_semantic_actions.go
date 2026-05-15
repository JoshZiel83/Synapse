package vfs

import (
	"context"
	"fmt"
)

func cuaSemanticNodeHasAction(node *cuaSemanticNode, action string) bool {
	if node == nil {
		return false
	}
	for _, candidate := range node.Actions {
		if candidate == action {
			return true
		}
	}
	return false
}

func (s *Service) writeCUASemanticAction(
	exposure Exposure,
	session *SessionState,
	node *cuaSemanticNode,
	action string,
	data []byte,
) (WriteResult, error) {
	switch action {
	case "click":
		payload, err := s.cuaSemanticCoordinatePayload(exposure, session, node)
		if err != nil {
			return WriteResult{}, err
		}
		result, err := s.callSessionTool(context.Background(), session, exposure.StableKey, "desktop_click", payload)
		if err != nil {
			return WriteResult{}, err
		}
		return cuaSemanticWriteEnvelope(result)
	case "type_text":
		payload, err := parseCUAActionPayload("type_text", data)
		if err != nil {
			return WriteResult{}, err
		}
		position, err := s.cuaSemanticCoordinatePayload(exposure, session, node)
		if err != nil {
			return WriteResult{}, err
		}
		for key, value := range position {
			payload[key] = value
		}
		result, err := s.callSessionTool(context.Background(), session, exposure.StableKey, "desktop_type_text", payload)
		if err != nil {
			return WriteResult{}, err
		}
		return cuaSemanticWriteEnvelope(result)
	default:
		return WriteResult{}, ErrNotFound
	}
}

func (s *Service) cuaSemanticCoordinatePayload(
	exposure Exposure,
	session *SessionState,
	node *cuaSemanticNode,
) (map[string]interface{}, error) {
	if node == nil || node.Bounds.W <= 0 || node.Bounds.H <= 0 {
		return nil, fmt.Errorf("semantic node %q does not expose clickable bounds", node.ID)
	}

	centerX := node.Bounds.X + node.Bounds.W/2
	centerY := node.Bounds.Y + node.Bounds.H/2
	displays, err := s.cuaDisplays(exposure, session)
	if err != nil {
		return nil, err
	}
	for _, display := range displays {
		displayMinX := display.Origin.X
		displayMaxX := display.Origin.X + display.Size.W
		displayMinY := display.Origin.Y
		displayMaxY := display.Origin.Y + display.Size.H
		if centerX < displayMinX || centerX >= displayMaxX || centerY < displayMinY || centerY >= displayMaxY {
			continue
		}
		return map[string]interface{}{
			"display": map[string]interface{}{
				"mode": "id",
				"id":   display.ID,
			},
			"coordinate": map[string]interface{}{
				"x": float64(centerX - display.Origin.X),
				"y": float64(centerY - display.Origin.Y),
			},
		}, nil
	}
	return nil, fmt.Errorf("semantic node %q bounds (%d,%d %dx%d) are outside detected displays", node.ID, node.Bounds.X, node.Bounds.Y, node.Bounds.W, node.Bounds.H)
}

func cuaSemanticWriteEnvelope(result *toolResult) (WriteResult, error) {
	envelope, err := resultEnvelope(result)
	if err != nil {
		return WriteResult{}, err
	}
	response, err := jsonBytes(envelope)
	if err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Data: response, MimeType: "application/json"}, nil
}
