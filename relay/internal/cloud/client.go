package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/deviceauth"
	"github.com/PekingSpades/Synapse/relay/internal/runtimeauth"
	"github.com/gorilla/websocket"
)

const (
	maxReconnectDelay   = 60 * time.Second
	baseReconnectDelay  = 1 * time.Second
	reconnectMultiplier = 2.0
	jitterFraction      = 0.25
)

var ErrPermanentAuthFailure = errors.New("permanent auth failure")
var ErrRestartRequired = errors.New("relay restart required")

type disconnectError struct{ err error }

func (d *disconnectError) Error() string { return d.err.Error() }
func (d *disconnectError) Unwrap() error { return d.err }

type authFailureError struct {
	code      string
	message   string
	permanent bool
}

func (e *authFailureError) Error() string {
	return e.message
}

func (e *authFailureError) Is(target error) bool {
	return target == ErrPermanentAuthFailure && e.permanent
}

type ToolCaller interface {
	CallTool(ctx context.Context, exposureStableKey, toolName string, args map[string]interface{}) (interface{}, error)
}

type TaskToolCaller interface {
	StartTask(
		ctx context.Context,
		exposureStableKey, toolName string,
		args map[string]interface{},
		requestedTaskID string,
	) (core.TaskSnapshot, error)
	GetTask(exposureStableKey, taskID string) (core.TaskSnapshot, error)
	ReadTaskOutput(
		exposureStableKey, taskID string,
		afterSeq int64,
		limit int,
		stream string,
	) ([]core.TaskOutputChunk, error)
	CancelTask(exposureStableKey, taskID, reason string) error
}

type RuntimeAuthorizationApplication struct {
	InteractionID     string
	RuntimeSessionID  string
	ExposureID        string
	ExposureStableKey string
	RelayToolName     string
	Reason            string
	Duration          string
	RequestedScope    map[string]interface{}
}

type RuntimeAuthorizationApplier interface {
	ApplyRuntimeAuthorization(ctx context.Context, application RuntimeAuthorizationApplication) error
}

type RuntimeSessionRequest struct {
	RuntimeSessionID  string
	ExposureID        string
	ExposureStableKey string
}

type RuntimeSessionManager interface {
	OpenRuntimeSession(ctx context.Context, request RuntimeSessionRequest) error
	CloseRuntimeSession(ctx context.Context, runtimeSessionID string) error
	ResetRuntimeSessions(ctx context.Context) error
}

type operationOutcome struct {
	success bool
	result  interface{}
	err     *RelayOperationError
}

type runningOperation struct {
	done    chan struct{}
	outcome operationOutcome
}

type taskBinding struct {
	exposureStableKey string
	taskID            string
}

type Client struct {
	relay          config.RelayConfig
	caller         ToolCaller
	authApplier    RuntimeAuthorizationApplier
	sessionManager RuntimeSessionManager
	syncSources    interface{}
	exposures      interface{}
	mu             sync.Mutex
	inflight       map[string]*runningOperation
	taskBindings   map[string]taskBinding
	journal        *OperationJournal
	clientVersion  string
	conn           *websocket.Conn
	writeMu        sync.Mutex
	catalogSyncMu  sync.Mutex
	catalogSyncCh  chan error
	BeforeConnect  func(ctx context.Context) error
	OnEvent        func(evtType string, msg string, data map[string]interface{})
}

func NewClient(
	relayCfg config.RelayConfig,
	caller ToolCaller,
	authApplier RuntimeAuthorizationApplier,
	sessionManager RuntimeSessionManager,
) *Client {
	return &Client{
		relay:          relayCfg,
		caller:         caller,
		authApplier:    authApplier,
		sessionManager: sessionManager,
		inflight:       make(map[string]*runningOperation),
		taskBindings:   make(map[string]taskBinding),
		journal:        NewOperationJournal(""),
	}
}

func (c *Client) SetClientVersion(version string) {
	c.clientVersion = version
}

func (c *Client) emit(evtType, msg string, data map[string]interface{}) {
	if c.OnEvent != nil {
		c.OnEvent(evtType, msg, data)
	}
}

func (c *Client) emitLog(msg string, data map[string]interface{}) {
	log.Printf("%s", msg)
	c.emit("log", msg, data)
}

func (c *Client) emitError(msg string, data map[string]interface{}) {
	log.Printf("%s", msg)
	c.emit("error", msg, data)
}

func asTrimmedString(value interface{}) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func summarizeRequestedScope(scope map[string]interface{}) string {
	capability := strings.ToLower(asTrimmedString(scope["capability"]))
	switch capability {
	case "filesystem":
		access := strings.ToLower(asTrimmedString(scope["access"]))
		path := asTrimmedString(scope["path"])
		switch {
		case access != "" && path != "":
			return fmt.Sprintf("filesystem %s access to %s", access, path)
		case path != "":
			return fmt.Sprintf("filesystem access to %s", path)
		default:
			return "filesystem access"
		}
	case "cua":
		mode := strings.ToLower(asTrimmedString(scope["mode"]))
		if mode == "" {
			mode = "control"
		}
		return fmt.Sprintf("cua %s access", mode)
	case "chrome":
		return "chrome browser access"
	default:
		if capability != "" {
			return fmt.Sprintf("%s access", capability)
		}
		return "runtime access"
	}
}

func (c *Client) SetExposures(exposures interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.exposures = exposures
}

func (c *Client) SetSyncSources(syncSources interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.syncSources = syncSources
}

func (c *Client) Run(ctx context.Context) error {
	attempt := 0

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		if c.BeforeConnect != nil {
			if err := c.BeforeConnect(ctx); err != nil {
				if errors.Is(err, ErrRestartRequired) {
					return nil
				}
				return err
			}
		}

		err := c.connectAndServe(ctx)
		if ctx.Err() != nil {
			return nil
		}

		var authFailure *authFailureError
		if errors.As(err, &authFailure) {
			c.emit("auth_failed", authFailure.message, map[string]interface{}{
				"code":      authFailure.code,
				"permanent": authFailure.permanent,
			})
		}

		if errors.Is(err, ErrPermanentAuthFailure) {
			log.Printf("Fatal relay authentication failure: %v", err)
			return err
		}

		var de *disconnectError
		if errors.As(err, &de) {
			attempt = 0
		}

		attempt++
		delay := c.backoffDelay(attempt)
		reason := relayFailureReason(err)
		phase := relayFailurePhase(reason)
		log.Printf("Relay disconnected (attempt %d): %v. Reconnecting in %v...", attempt, err, delay)
		c.emit("log", fmt.Sprintf("Relay reconnect reason: %s", reason), map[string]interface{}{
			"attempt": attempt,
			"phase":   phase,
			"reason":  reason,
			"retryIn": delay.String(),
		})
		c.emit("disconnected", fmt.Sprintf("Relay disconnected, reconnecting in %v", delay), map[string]interface{}{
			"attempt": attempt,
			"phase":   phase,
			"reason":  reason,
			"retryIn": delay.String(),
		})

		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
	}
}

func (c *Client) connectAndServe(ctx context.Context) error {
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}
	tlsConfig, err := buildPinnedTLSConfig(c.relay.WebSocketURL, c.relay.ServerTLSPublicKeyPin, nil)
	if err != nil {
		return &authFailureError{
			code:      "server_identity_invalid",
			message:   err.Error(),
			permanent: true,
		}
	}
	if tlsConfig != nil {
		dialer.TLSClientConfig = tlsConfig
	}

	c.emit("connecting", fmt.Sprintf("Connecting to %s...", c.relay.WebSocketURL), nil)
	conn, _, err := dialer.DialContext(ctx, c.relay.WebSocketURL, http.Header{})
	if err != nil {
		var pinErr *serverIdentityError
		if errors.As(err, &pinErr) {
			return &authFailureError{
				code:      "server_identity_mismatch",
				message:   pinErr.Error(),
				permanent: true,
			}
		}
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	authOK, err := c.authenticate(conn)
	if err != nil {
		return err
	}
	if c.sessionManager != nil {
		if err := c.sessionManager.ResetRuntimeSessions(ctx); err != nil {
			c.emitError(
				fmt.Sprintf("Failed to reset local runtime sessions after authentication: %v", err),
				map[string]interface{}{
					"phase": "post_auth_reset",
				},
			)
		} else {
			c.emitLog(
				"Reset local runtime sessions after authentication.",
				map[string]interface{}{
					"phase": "post_auth_reset",
				},
			)
		}
	}
	defer func() {
		if c.sessionManager != nil {
			if err := c.sessionManager.ResetRuntimeSessions(context.Background()); err != nil {
				c.emitError(
					fmt.Sprintf("Failed to reset local runtime sessions after disconnect: %v", err),
					map[string]interface{}{
						"phase": "disconnect_reset",
					},
				)
			} else {
				c.emitLog(
					"Reset local runtime sessions after disconnect.",
					map[string]interface{}{
						"phase": "disconnect_reset",
					},
				)
			}
		}
	}()

	c.emit("log", fmt.Sprintf("Authenticated relay device %s; syncing relay catalog...", authOK.DeviceID), map[string]interface{}{
		"deviceId":  authOK.DeviceID,
		"sessionId": authOK.SessionID,
	})

	if err := c.writeCatalogSync(conn); err != nil {
		return fmt.Errorf("send catalog sync: %w", err)
	}

	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("read catalog sync response: %w", err)
	}
	conn.SetReadDeadline(time.Time{})

	var syncAck GenericMessage
	if err := json.Unmarshal(raw, &syncAck); err != nil {
		return fmt.Errorf("parse catalog sync response: %w", err)
	}
	if syncAck.Type == "catalog.sync_error" {
		var syncErr AuthErrorMessage
		_ = json.Unmarshal(raw, &syncErr)
		return fmt.Errorf("catalog sync rejected: %s", syncErr.Message)
	}
	if syncAck.Type != "catalog.synced" {
		return fmt.Errorf("unexpected catalog sync response type: %s", syncAck.Type)
	}

	var synced CatalogSyncedMessage
	if err := json.Unmarshal(raw, &synced); err != nil {
		return fmt.Errorf("parse catalog synced response: %w", err)
	}

	c.setConnection(conn)
	defer c.clearConnection(conn)
	c.emit("connected", fmt.Sprintf("Relay connected as device %s", authOK.DeviceID), map[string]interface{}{
		"deviceId":      authOK.DeviceID,
		"exposureCount": synced.ExposureCount,
		"sessionId":     authOK.SessionID,
	})

	if err := c.readLoop(ctx, conn); err != nil {
		return &disconnectError{err: err}
	}
	return &disconnectError{err: fmt.Errorf("relay connection closed")}
}

func relayFailureReason(err error) string {
	if err == nil {
		return ""
	}

	var de *disconnectError
	if errors.As(err, &de) && de.err != nil {
		return de.err.Error()
	}

	return err.Error()
}

func relayFailurePhase(reason string) string {
	switch {
	case strings.HasPrefix(reason, "dial:"):
		return "dial"
	case strings.HasPrefix(reason, "send auth.begin:"), strings.HasPrefix(reason, "send auth.finish:"):
		return "auth_write"
	case strings.HasPrefix(reason, "read auth challenge:"):
		return "auth_challenge"
	case strings.HasPrefix(reason, "read auth result:"):
		return "auth_result"
	case strings.HasPrefix(reason, "send catalog sync:"):
		return "catalog_sync_send"
	case strings.HasPrefix(reason, "read catalog sync response:"):
		return "catalog_sync_response"
	case strings.HasPrefix(reason, "parse catalog sync response:"):
		return "catalog_sync_response"
	case strings.HasPrefix(reason, "parse catalog synced response:"):
		return "catalog_sync_response"
	case strings.HasPrefix(reason, "catalog sync rejected:"):
		return "catalog_sync_rejected"
	case strings.HasPrefix(reason, "unexpected catalog sync response type:"):
		return "catalog_sync_response"
	case strings.HasPrefix(reason, "server shutdown"):
		return "server_shutdown"
	case strings.HasPrefix(reason, "read:"), reason == "relay connection closed":
		return "connected_session"
	default:
		return "unknown"
	}
}

func (c *Client) authenticate(conn *websocket.Conn) (*AuthOKMessage, error) {
	begin := AuthBeginMessage{
		Type:                 "auth.begin",
		DeviceID:             c.relay.DeviceID,
		PublicKeyFingerprint: c.relay.PublicKeyFingerprint,
		ProtocolVersion:      2,
		ClientVersion:        c.clientVersion,
	}
	if err := conn.WriteJSON(begin); err != nil {
		return nil, fmt.Errorf("send auth.begin: %w", err)
	}

	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		return nil, fmt.Errorf("read auth challenge: %w", err)
	}

	var generic GenericMessage
	if err := json.Unmarshal(raw, &generic); err != nil {
		return nil, fmt.Errorf("parse auth challenge: %w", err)
	}
	if generic.Type == "auth_error" {
		var authErr AuthErrorMessage
		_ = json.Unmarshal(raw, &authErr)
		return nil, classifyAuthFailure(authErr, false)
	}
	if generic.Type != "auth.challenge" {
		return nil, fmt.Errorf("unexpected auth response type: %s", generic.Type)
	}

	var challenge AuthChallengeMessage
	if err := json.Unmarshal(raw, &challenge); err != nil {
		return nil, fmt.Errorf("parse auth.challenge: %w", err)
	}

	signature, err := deviceauth.SignChallenge(c.relay.PrivateKeyPath, c.relay.DeviceID, challenge.Challenge, challenge.Nonce)
	if err != nil {
		return nil, fmt.Errorf("sign auth challenge: %w", err)
	}

	if err := conn.WriteJSON(AuthFinishMessage{
		Type:      "auth.finish",
		DeviceID:  c.relay.DeviceID,
		Challenge: challenge.Challenge,
		Signature: signature,
	}); err != nil {
		return nil, fmt.Errorf("send auth.finish: %w", err)
	}

	_, raw, err = conn.ReadMessage()
	conn.SetReadDeadline(time.Time{})
	if err != nil {
		return nil, fmt.Errorf("read auth result: %w", err)
	}

	if err := json.Unmarshal(raw, &generic); err != nil {
		return nil, fmt.Errorf("parse auth result: %w", err)
	}
	if generic.Type == "auth_error" {
		var authErr AuthErrorMessage
		_ = json.Unmarshal(raw, &authErr)
		return nil, classifyAuthFailure(authErr, false)
	}
	if generic.Type != "auth_ok" {
		return nil, fmt.Errorf("unexpected auth result type: %s", generic.Type)
	}

	var authOK AuthOKMessage
	if err := json.Unmarshal(raw, &authOK); err != nil {
		return nil, fmt.Errorf("parse auth_ok: %w", err)
	}
	return &authOK, nil
}

func classifyAuthFailure(msg AuthErrorMessage, defaultPermanent bool) error {
	code := strings.TrimSpace(msg.Code)
	if code == "" {
		code = "auth_error"
	}
	message := strings.TrimSpace(msg.Message)
	if message == "" {
		message = "relay authentication failed"
	}
	permanent := defaultPermanent || !msg.Retryable
	return &authFailureError{
		code:      code,
		message:   message,
		permanent: permanent,
	}
}

func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) error {
	loopDone := make(chan struct{})
	defer close(loopDone)

	go closeConnectionOnContext(ctx, conn, loopDone)

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}

		var generic GenericMessage
		if err := json.Unmarshal(raw, &generic); err != nil {
			log.Printf("Failed to parse relay message: %v", err)
			continue
		}

		switch generic.Type {
		case "ping":
			err = c.writeJSON(conn, PongMessage{Type: "pong"})
			if err != nil {
				return fmt.Errorf("write pong: %w", err)
			}
		case "catalog.synced":
			c.resolveCatalogSync(nil)
			continue
		case "catalog.sync_error":
			var syncErr AuthErrorMessage
			_ = json.Unmarshal(raw, &syncErr)
			c.resolveCatalogSync(fmt.Errorf("catalog sync rejected: %s", syncErr.Message))
			log.Printf("Relay catalog sync error: %s", syncErr.Message)
		case "server_shutdown":
			c.resolveCatalogSync(fmt.Errorf("server shutdown"))
			return fmt.Errorf("server shutdown")
		case "relay.operation.dispatch":
			var dispatch RelayDispatchMessage
			if err := json.Unmarshal(raw, &dispatch); err != nil {
				log.Printf("Failed to parse relay dispatch: %v", err)
				continue
			}
			go c.handleOperationDispatch(ctx, conn, loopDone, dispatch)
		case "relay.operation.cancel":
			var cancelMsg RelayOperationCancelMessage
			if err := json.Unmarshal(raw, &cancelMsg); err != nil {
				log.Printf("Failed to parse relay operation cancel: %v", err)
				continue
			}
			go c.handleOperationCancel(conn, cancelMsg)
		case "relay.authorization.apply":
			var apply RelayAuthorizationApplyMessage
			if err := json.Unmarshal(raw, &apply); err != nil {
				log.Printf("Failed to parse relay authorization apply: %v", err)
				continue
			}
			go c.handleAuthorizationApply(ctx, conn, apply)
		case "relay.runtime_session.open":
			var open RelayRuntimeSessionOpenMessage
			if err := json.Unmarshal(raw, &open); err != nil {
				log.Printf("Failed to parse relay runtime session open: %v", err)
				continue
			}
			go c.handleRuntimeSessionOpen(ctx, conn, open)
		case "relay.runtime_session.close":
			var closeMsg RelayRuntimeSessionCloseMessage
			if err := json.Unmarshal(raw, &closeMsg); err != nil {
				log.Printf("Failed to parse relay runtime session close: %v", err)
				continue
			}
			go c.handleRuntimeSessionClose(ctx, conn, closeMsg)
		}
	}
}

func closeConnectionOnContext(ctx context.Context, conn interface{ Close() error }, done <-chan struct{}) {
	select {
	case <-ctx.Done():
		_ = conn.Close()
	case <-done:
	}
}

func (c *Client) handleOperationDispatch(
	ctx context.Context,
	conn *websocket.Conn,
	connDone <-chan struct{},
	dispatch RelayDispatchMessage,
) {
	c.emit("tool_call", dispatch.Payload.ToolName, map[string]interface{}{
		"operationId":       dispatch.OperationID,
		"exposureStableKey": dispatch.Payload.ExposureStableKey,
		"toolName":          dispatch.Payload.ToolName,
		"runtimeSessionId":  dispatch.Payload.RuntimeSessionID,
	})

	_ = c.writeJSON(conn, OperationReceivedMessage{
		Type:        "operation.received",
		OperationID: dispatch.OperationID,
		DeliveryID:  dispatch.DeliveryID,
	})

	entry, exists := c.journal.Get(dispatch.OperationID)
	if exists && entry.InputHash != "" && dispatch.Payload.InputHash != "" && entry.InputHash != dispatch.Payload.InputHash {
		c.sendOperationOutcome(conn, dispatch.OperationID, dispatch.DeliveryID, operationOutcome{
			success: false,
			err: &RelayOperationError{
				Code:      "delivery_rejected",
				Message:   "Relay operation payload changed for an existing operation_id",
				Retryable: false,
			},
		})
		return
	}

	if exists && (entry.Status == "completed" || entry.Status == "failed") {
		c.sendJournalOutcome(conn, dispatch.OperationID, dispatch.DeliveryID, entry)
		return
	}

	c.mu.Lock()
	inflight := c.inflight[dispatch.OperationID]
	isNewExecution := false
	if inflight == nil {
		inflight = &runningOperation{done: make(chan struct{})}
		c.inflight[dispatch.OperationID] = inflight
		isNewExecution = true
	}
	c.mu.Unlock()

	if !isNewExecution {
		if dispatch.Payload.ResponseMode == "async" {
			if taskCaller, ok := c.caller.(TaskToolCaller); ok {
				go c.mirrorAsyncTaskToConnection(conn, connDone, dispatch, taskCaller)
			}
		}
		c.waitAndSendRunningOutcome(ctx, conn, connDone, dispatch.OperationID, dispatch.DeliveryID, inflight)
		return
	}

	c.journal.UpsertPending(dispatch.OperationID, dispatch.Payload.InputHash, dispatch.Payload.ExposureStableKey, dispatch.Payload.ToolName, "received")

	_ = c.writeJSON(conn, OperationStartedMessage{
		Type:        "operation.started",
		OperationID: dispatch.OperationID,
		DeliveryID:  dispatch.DeliveryID,
	})

	c.journal.UpsertPending(dispatch.OperationID, dispatch.Payload.InputHash, dispatch.Payload.ExposureStableKey, dispatch.Payload.ToolName, "started")

	if dispatch.Payload.ResponseMode == "async" {
		if taskCaller, ok := c.caller.(TaskToolCaller); ok {
			callCtx := runtimeauth.ContextWithRuntimeSessionID(context.Background(), dispatch.Payload.RuntimeSessionID)
			snapshot, err := taskCaller.StartTask(
				callCtx,
				dispatch.Payload.ExposureStableKey,
				dispatch.Payload.ToolName,
				dispatch.Payload.Arguments,
				dispatch.OperationID,
			)
			if err != nil {
				opErr := normalizeOperationError(err)
				outcome := operationOutcome{success: false, err: opErr}
				c.journal.MarkFailed(dispatch.OperationID, dispatch.Payload.InputHash, dispatch.Payload.ExposureStableKey, dispatch.Payload.ToolName, opErr)
				c.completeRunningOperation(dispatch.OperationID, inflight, outcome)
				c.sendOperationOutcome(conn, dispatch.OperationID, dispatch.DeliveryID, outcome)
				c.emit("tool_result", fmt.Sprintf("%s failed: %s", dispatch.Payload.ToolName, err.Error()), map[string]interface{}{
					"operationId":      dispatch.OperationID,
					"runtimeSessionId": dispatch.Payload.RuntimeSessionID,
					"error":            true,
				})
				return
			}

			c.setTaskBinding(dispatch.OperationID, dispatch.Payload.ExposureStableKey, snapshot.TaskID)
			go c.watchAsyncTask(dispatch, inflight, taskCaller)
			go c.mirrorAsyncTaskToConnection(conn, connDone, dispatch, taskCaller)
			c.waitAndSendRunningOutcome(ctx, conn, connDone, dispatch.OperationID, dispatch.DeliveryID, inflight)
			return
		}
	}

	callCtx := ctx
	cancel := func() {}
	if dispatch.Payload.ExpiresInMs > 0 {
		callCtx, cancel = context.WithTimeout(ctx, time.Duration(dispatch.Payload.ExpiresInMs)*time.Millisecond)
	}
	defer cancel()
	callCtx = runtimeauth.ContextWithRuntimeSessionID(callCtx, dispatch.Payload.RuntimeSessionID)

	result, err := c.caller.CallTool(callCtx, dispatch.Payload.ExposureStableKey, dispatch.Payload.ToolName, dispatch.Payload.Arguments)
	if err != nil {
		opErr := normalizeOperationError(err)
		outcome := operationOutcome{success: false, err: opErr}
		c.journal.MarkFailed(dispatch.OperationID, dispatch.Payload.InputHash, dispatch.Payload.ExposureStableKey, dispatch.Payload.ToolName, opErr)
		c.completeRunningOperation(dispatch.OperationID, inflight, outcome)
		c.sendOperationOutcome(conn, dispatch.OperationID, dispatch.DeliveryID, outcome)
		c.emit("tool_result", fmt.Sprintf("%s failed: %s", dispatch.Payload.ToolName, err.Error()), map[string]interface{}{
			"operationId":      dispatch.OperationID,
			"runtimeSessionId": dispatch.Payload.RuntimeSessionID,
			"error":            true,
		})
		return
	}

	outcome := operationOutcome{success: true, result: result}
	c.journal.MarkCompleted(dispatch.OperationID, dispatch.Payload.InputHash, dispatch.Payload.ExposureStableKey, dispatch.Payload.ToolName, result)
	c.completeRunningOperation(dispatch.OperationID, inflight, outcome)
	c.sendOperationOutcome(conn, dispatch.OperationID, dispatch.DeliveryID, outcome)
	c.emit("tool_result", fmt.Sprintf("%s completed", dispatch.Payload.ToolName), map[string]interface{}{
		"operationId":      dispatch.OperationID,
		"runtimeSessionId": dispatch.Payload.RuntimeSessionID,
		"error":            false,
	})
}

func (c *Client) handleAuthorizationApply(
	ctx context.Context,
	conn *websocket.Conn,
	apply RelayAuthorizationApplyMessage,
) {
	scopeSummary := summarizeRequestedScope(apply.Payload.RequestedScope)
	c.emitLog(
		fmt.Sprintf(
			"Applying relay authorization %s for runtime session %s (%s).",
			apply.InteractionID,
			apply.Payload.RuntimeSessionID,
			scopeSummary,
		),
		map[string]interface{}{
			"interactionId":     apply.InteractionID,
			"deliveryId":        apply.DeliveryID,
			"runtimeSessionId":  apply.Payload.RuntimeSessionID,
			"exposureId":        apply.Payload.ExposureID,
			"exposureStableKey": apply.Payload.ExposureStableKey,
			"relayToolName":     apply.Payload.RelayToolName,
			"duration":          apply.Payload.Duration,
			"requestedScope":    apply.Payload.RequestedScope,
			"scopeSummary":      scopeSummary,
			"reason":            apply.Payload.Reason,
		},
	)
	if c.authApplier == nil {
		c.emitError(
			fmt.Sprintf(
				"Rejected relay authorization %s because runtime authorization is not supported by this client.",
				apply.InteractionID,
			),
			map[string]interface{}{
				"interactionId":     apply.InteractionID,
				"deliveryId":        apply.DeliveryID,
				"runtimeSessionId":  apply.Payload.RuntimeSessionID,
				"exposureId":        apply.Payload.ExposureID,
				"exposureStableKey": apply.Payload.ExposureStableKey,
			},
		)
		_ = c.writeJSON(conn, AuthorizationResultMessage{
			Type:          "authorization.result",
			InteractionID: apply.InteractionID,
			DeliveryID:    apply.DeliveryID,
			Success:       false,
			Error: &RelayOperationError{
				Code:      "tool_execution_failed",
				Message:   "relay runtime authorization is not supported by this client",
				Retryable: false,
			},
		})
		return
	}

	err := c.authApplier.ApplyRuntimeAuthorization(ctx, RuntimeAuthorizationApplication{
		InteractionID:     apply.InteractionID,
		RuntimeSessionID:  apply.Payload.RuntimeSessionID,
		ExposureID:        apply.Payload.ExposureID,
		ExposureStableKey: apply.Payload.ExposureStableKey,
		RelayToolName:     apply.Payload.RelayToolName,
		Reason:            apply.Payload.Reason,
		Duration:          apply.Payload.Duration,
		RequestedScope:    apply.Payload.RequestedScope,
	})
	if err != nil {
		c.emitError(
			fmt.Sprintf(
				"Relay authorization %s failed for runtime session %s: %v",
				apply.InteractionID,
				apply.Payload.RuntimeSessionID,
				err,
			),
			map[string]interface{}{
				"interactionId":     apply.InteractionID,
				"deliveryId":        apply.DeliveryID,
				"runtimeSessionId":  apply.Payload.RuntimeSessionID,
				"exposureId":        apply.Payload.ExposureID,
				"exposureStableKey": apply.Payload.ExposureStableKey,
				"relayToolName":     apply.Payload.RelayToolName,
				"duration":          apply.Payload.Duration,
				"requestedScope":    apply.Payload.RequestedScope,
				"scopeSummary":      scopeSummary,
				"error":             err.Error(),
			},
		)
		_ = c.writeJSON(conn, AuthorizationResultMessage{
			Type:          "authorization.result",
			InteractionID: apply.InteractionID,
			DeliveryID:    apply.DeliveryID,
			Success:       false,
			Error:         normalizeOperationError(err),
		})
		return
	}

	c.emitLog(
		fmt.Sprintf(
			"Relay authorization %s applied for runtime session %s (%s).",
			apply.InteractionID,
			apply.Payload.RuntimeSessionID,
			scopeSummary,
		),
		map[string]interface{}{
			"interactionId":     apply.InteractionID,
			"deliveryId":        apply.DeliveryID,
			"runtimeSessionId":  apply.Payload.RuntimeSessionID,
			"exposureId":        apply.Payload.ExposureID,
			"exposureStableKey": apply.Payload.ExposureStableKey,
			"relayToolName":     apply.Payload.RelayToolName,
			"duration":          apply.Payload.Duration,
			"requestedScope":    apply.Payload.RequestedScope,
			"scopeSummary":      scopeSummary,
		},
	)

	_ = c.writeJSON(conn, AuthorizationResultMessage{
		Type:          "authorization.result",
		InteractionID: apply.InteractionID,
		DeliveryID:    apply.DeliveryID,
		Success:       true,
	})
}

func (c *Client) handleRuntimeSessionOpen(
	ctx context.Context,
	conn *websocket.Conn,
	open RelayRuntimeSessionOpenMessage,
) {
	c.emitLog(
		fmt.Sprintf(
			"Opening relay runtime session %s for exposure %s.",
			open.RuntimeSessionID,
			open.Payload.ExposureStableKey,
		),
		map[string]interface{}{
			"action":            "open",
			"runtimeSessionId":  open.RuntimeSessionID,
			"deliveryId":        open.DeliveryID,
			"exposureId":        open.Payload.ExposureID,
			"exposureStableKey": open.Payload.ExposureStableKey,
		},
	)
	if c.sessionManager == nil {
		c.emitError(
			fmt.Sprintf(
				"Failed to open relay runtime session %s because runtime sessions are not supported by this client.",
				open.RuntimeSessionID,
			),
			map[string]interface{}{
				"action":            "open",
				"runtimeSessionId":  open.RuntimeSessionID,
				"deliveryId":        open.DeliveryID,
				"exposureId":        open.Payload.ExposureID,
				"exposureStableKey": open.Payload.ExposureStableKey,
			},
		)
		_ = c.writeJSON(conn, RuntimeSessionResultMessage{
			Type:             "runtime_session.result",
			Action:           "open",
			RuntimeSessionID: open.RuntimeSessionID,
			DeliveryID:       open.DeliveryID,
			Success:          false,
			Error: &RelayOperationError{
				Code:      "tool_execution_failed",
				Message:   "relay runtime sessions are not supported by this client",
				Retryable: false,
			},
		})
		return
	}

	err := c.sessionManager.OpenRuntimeSession(ctx, RuntimeSessionRequest{
		RuntimeSessionID:  open.RuntimeSessionID,
		ExposureID:        open.Payload.ExposureID,
		ExposureStableKey: open.Payload.ExposureStableKey,
	})
	if err != nil {
		c.emitError(
			fmt.Sprintf(
				"Failed to open relay runtime session %s for exposure %s: %v",
				open.RuntimeSessionID,
				open.Payload.ExposureStableKey,
				err,
			),
			map[string]interface{}{
				"action":            "open",
				"runtimeSessionId":  open.RuntimeSessionID,
				"deliveryId":        open.DeliveryID,
				"exposureId":        open.Payload.ExposureID,
				"exposureStableKey": open.Payload.ExposureStableKey,
				"error":             err.Error(),
			},
		)
		_ = c.writeJSON(conn, RuntimeSessionResultMessage{
			Type:             "runtime_session.result",
			Action:           "open",
			RuntimeSessionID: open.RuntimeSessionID,
			DeliveryID:       open.DeliveryID,
			Success:          false,
			Error:            normalizeOperationError(err),
		})
		return
	}

	c.emitLog(
		fmt.Sprintf(
			"Opened relay runtime session %s for exposure %s.",
			open.RuntimeSessionID,
			open.Payload.ExposureStableKey,
		),
		map[string]interface{}{
			"action":            "open",
			"runtimeSessionId":  open.RuntimeSessionID,
			"deliveryId":        open.DeliveryID,
			"exposureId":        open.Payload.ExposureID,
			"exposureStableKey": open.Payload.ExposureStableKey,
		},
	)

	_ = c.writeJSON(conn, RuntimeSessionResultMessage{
		Type:             "runtime_session.result",
		Action:           "open",
		RuntimeSessionID: open.RuntimeSessionID,
		DeliveryID:       open.DeliveryID,
		Success:          true,
	})
}

func (c *Client) handleRuntimeSessionClose(
	ctx context.Context,
	conn *websocket.Conn,
	closeMsg RelayRuntimeSessionCloseMessage,
) {
	c.emitLog(
		fmt.Sprintf("Closing relay runtime session %s.", closeMsg.RuntimeSessionID),
		map[string]interface{}{
			"action":           "close",
			"runtimeSessionId": closeMsg.RuntimeSessionID,
			"deliveryId":       closeMsg.DeliveryID,
		},
	)
	if c.sessionManager == nil {
		c.emitLog(
			fmt.Sprintf(
				"Relay runtime session %s close acknowledged without a local session manager.",
				closeMsg.RuntimeSessionID,
			),
			map[string]interface{}{
				"action":           "close",
				"runtimeSessionId": closeMsg.RuntimeSessionID,
				"deliveryId":       closeMsg.DeliveryID,
				"skipped":          true,
			},
		)
		_ = c.writeJSON(conn, RuntimeSessionResultMessage{
			Type:             "runtime_session.result",
			Action:           "close",
			RuntimeSessionID: closeMsg.RuntimeSessionID,
			DeliveryID:       closeMsg.DeliveryID,
			Success:          true,
		})
		return
	}

	err := c.sessionManager.CloseRuntimeSession(ctx, closeMsg.RuntimeSessionID)
	if err != nil {
		c.emitError(
			fmt.Sprintf(
				"Failed to close relay runtime session %s: %v",
				closeMsg.RuntimeSessionID,
				err,
			),
			map[string]interface{}{
				"action":           "close",
				"runtimeSessionId": closeMsg.RuntimeSessionID,
				"deliveryId":       closeMsg.DeliveryID,
				"error":            err.Error(),
			},
		)
		_ = c.writeJSON(conn, RuntimeSessionResultMessage{
			Type:             "runtime_session.result",
			Action:           "close",
			RuntimeSessionID: closeMsg.RuntimeSessionID,
			DeliveryID:       closeMsg.DeliveryID,
			Success:          false,
			Error:            normalizeOperationError(err),
		})
		return
	}

	c.emitLog(
		fmt.Sprintf("Closed relay runtime session %s.", closeMsg.RuntimeSessionID),
		map[string]interface{}{
			"action":           "close",
			"runtimeSessionId": closeMsg.RuntimeSessionID,
			"deliveryId":       closeMsg.DeliveryID,
		},
	)

	_ = c.writeJSON(conn, RuntimeSessionResultMessage{
		Type:             "runtime_session.result",
		Action:           "close",
		RuntimeSessionID: closeMsg.RuntimeSessionID,
		DeliveryID:       closeMsg.DeliveryID,
		Success:          true,
	})
}

func (c *Client) sendOperationOutcome(conn *websocket.Conn, operationID, deliveryID string, outcome operationOutcome) {
	msg := OperationResultMessage{
		Type:        "operation.result",
		OperationID: operationID,
		DeliveryID:  deliveryID,
		Success:     outcome.success,
		Result:      outcome.result,
		Error:       outcome.err,
	}

	err := c.writeJSON(conn, msg)
	if err != nil {
		log.Printf("Failed to send relay operation result %s: %v", operationID, err)
	}
}

func (c *Client) sendJournalOutcome(conn *websocket.Conn, operationID, deliveryID string, entry JournalEntry) {
	outcome := operationOutcome{
		success: entry.Status == "completed",
		result:  entry.Result,
		err:     cloneRelayOperationError(entry.Error),
	}
	c.sendOperationOutcome(conn, operationID, deliveryID, outcome)
}

func (c *Client) waitAndSendRunningOutcome(
	ctx context.Context,
	conn *websocket.Conn,
	connDone <-chan struct{},
	operationID string,
	deliveryID string,
	inflight *runningOperation,
) {
	_ = c.writeJSON(conn, OperationStartedMessage{
		Type:        "operation.started",
		OperationID: operationID,
		DeliveryID:  deliveryID,
	})

	go func() {
		select {
		case <-ctx.Done():
			return
		case <-connDone:
			return
		case <-inflight.done:
			c.sendOperationOutcome(conn, operationID, deliveryID, inflight.outcome)
		}
	}()
}

func (c *Client) completeRunningOperation(operationID string, inflight *runningOperation, outcome operationOutcome) {
	inflight.outcome = outcome
	close(inflight.done)

	c.mu.Lock()
	delete(c.inflight, operationID)
	delete(c.taskBindings, operationID)
	c.mu.Unlock()
}

func (c *Client) setTaskBinding(operationID, exposureStableKey, taskID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.taskBindings[operationID] = taskBinding{
		exposureStableKey: exposureStableKey,
		taskID:            taskID,
	}
}

func (c *Client) getTaskBinding(operationID string) (taskBinding, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	binding, ok := c.taskBindings[operationID]
	return binding, ok
}

func (c *Client) watchAsyncTask(
	dispatch RelayDispatchMessage,
	inflight *runningOperation,
	taskCaller TaskToolCaller,
) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	for {
		binding, ok := c.getTaskBinding(dispatch.OperationID)
		if !ok {
			outcome := operationOutcome{
				success: false,
				err: &RelayOperationError{
					Code:      "delivery_rejected",
					Message:   "Relay task binding was lost before completion",
					Retryable: false,
				},
			}
			c.journal.MarkFailed(dispatch.OperationID, dispatch.Payload.InputHash, dispatch.Payload.ExposureStableKey, dispatch.Payload.ToolName, outcome.err)
			c.completeRunningOperation(dispatch.OperationID, inflight, outcome)
			return
		}

		snapshot, err := taskCaller.GetTask(binding.exposureStableKey, binding.taskID)
		if err != nil {
			opErr := normalizeOperationError(err)
			c.journal.MarkFailed(dispatch.OperationID, dispatch.Payload.InputHash, dispatch.Payload.ExposureStableKey, dispatch.Payload.ToolName, opErr)
			c.completeRunningOperation(dispatch.OperationID, inflight, operationOutcome{
				success: false,
				err:     opErr,
			})
			return
		}

		switch snapshot.Status {
		case core.TaskStatusWorking:
		case core.TaskStatusCancelled:
			outcome := operationOutcome{
				success: false,
				err: &RelayOperationError{
					Code:      "operation_cancelled",
					Message:   snapshot.StatusMessage,
					Retryable: false,
				},
			}
			c.journal.MarkFailed(dispatch.OperationID, dispatch.Payload.InputHash, dispatch.Payload.ExposureStableKey, dispatch.Payload.ToolName, outcome.err)
			c.completeRunningOperation(dispatch.OperationID, inflight, outcome)
			return
		case core.TaskStatusCompleted, core.TaskStatusFailed:
			if snapshot.Result == nil {
				opErr := &RelayOperationError{
					Code:      "execution_failed",
					Message:   "Relay task completed without a final result payload",
					Retryable: false,
				}
				c.journal.MarkFailed(dispatch.OperationID, dispatch.Payload.InputHash, dispatch.Payload.ExposureStableKey, dispatch.Payload.ToolName, opErr)
				c.completeRunningOperation(dispatch.OperationID, inflight, operationOutcome{
					success: false,
					err:     opErr,
				})
				return
			}

			result := callResultPayload(snapshot.Result)
			outcome := operationOutcome{
				success: true,
				result:  result,
			}
			if snapshot.Status == core.TaskStatusCompleted {
				c.journal.MarkCompleted(dispatch.OperationID, dispatch.Payload.InputHash, dispatch.Payload.ExposureStableKey, dispatch.Payload.ToolName, result)
			} else {
				c.journal.MarkCompleted(dispatch.OperationID, dispatch.Payload.InputHash, dispatch.Payload.ExposureStableKey, dispatch.Payload.ToolName, result)
			}
			c.completeRunningOperation(dispatch.OperationID, inflight, outcome)
			return
		}

		<-ticker.C
	}
}

func (c *Client) mirrorAsyncTaskToConnection(
	conn *websocket.Conn,
	connDone <-chan struct{},
	dispatch RelayDispatchMessage,
	taskCaller TaskToolCaller,
) {
	var afterSeq int64
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	for {
		binding, ok := c.getTaskBinding(dispatch.OperationID)
		if !ok {
			return
		}

		chunks, err := taskCaller.ReadTaskOutput(binding.exposureStableKey, binding.taskID, afterSeq, 128, "")
		if err == nil {
			for _, chunk := range chunks {
				afterSeq = chunk.Seq
				select {
				case <-connDone:
				default:
					_ = c.writeJSON(conn, OperationOutputMessage{
						Type:        "operation.output",
						OperationID: dispatch.OperationID,
						DeliveryID:  dispatch.DeliveryID,
						Seq:         chunk.Seq,
						Stream:      chunk.Stream,
						Text:        chunk.Text,
						CreatedAt:   chunk.CreatedAt,
					})
				}
			}
		}

		c.mu.Lock()
		inflight := c.inflight[dispatch.OperationID]
		c.mu.Unlock()
		if inflight == nil {
			return
		}

		select {
		case <-inflight.done:
			return
		case <-ticker.C:
		}
	}
}

func callResultPayload(result *core.CallResult) interface{} {
	if result == nil {
		return nil
	}
	return map[string]interface{}{
		"content":           result.Content,
		"structuredContent": result.StructuredContent,
		"isError":           result.IsError,
	}
}

func (c *Client) handleOperationCancel(
	conn *websocket.Conn,
	cancelMsg RelayOperationCancelMessage,
) {
	binding, ok := c.getTaskBinding(cancelMsg.OperationID)
	if !ok {
		if entry, exists := c.journal.Get(cancelMsg.OperationID); exists && (entry.Status == "completed" || entry.Status == "failed") {
			c.sendJournalOutcome(conn, cancelMsg.OperationID, cancelMsg.DeliveryID, entry)
		}
		return
	}

	taskCaller, ok := c.caller.(TaskToolCaller)
	if !ok {
		c.sendOperationOutcome(conn, cancelMsg.OperationID, cancelMsg.DeliveryID, operationOutcome{
			success: false,
			err: &RelayOperationError{
				Code:      "delivery_rejected",
				Message:   "Relay tool does not support cancellation",
				Retryable: false,
			},
		})
		return
	}

	if err := taskCaller.CancelTask(binding.exposureStableKey, binding.taskID, cancelMsg.Reason); err != nil && !errors.Is(err, core.ErrTaskNotFound) {
		c.sendOperationOutcome(conn, cancelMsg.OperationID, cancelMsg.DeliveryID, operationOutcome{
			success: false,
			err:     normalizeOperationError(err),
		})
	}
}

func (c *Client) SyncCatalog(ctx context.Context) error {
	c.catalogSyncMu.Lock()
	defer c.catalogSyncMu.Unlock()

	conn := c.getConnection()
	if conn == nil {
		return fmt.Errorf("relay is not connected")
	}

	waitCh := make(chan error, 1)
	c.mu.Lock()
	c.catalogSyncCh = waitCh
	c.mu.Unlock()
	defer c.clearCatalogSyncWait(waitCh)

	if err := c.writeCatalogSync(conn); err != nil {
		return err
	}

	select {
	case err := <-waitCh:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(10 * time.Second):
		return fmt.Errorf("timeout waiting for catalog sync acknowledgement")
	}
}

func normalizeOperationError(err error) *RelayOperationError {
	message := err.Error()
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return &RelayOperationError{
			Code:      "operation_expired",
			Message:   "Relay operation timed out before completion",
			Retryable: true,
		}
	case errors.Is(err, context.Canceled):
		return &RelayOperationError{
			Code:      "delivery_rejected",
			Message:   "Relay operation was cancelled",
			Retryable: true,
		}
	case strings.Contains(message, "relay exposure"):
		return &RelayOperationError{
			Code:      "mcp_unavailable",
			Message:   message,
			Retryable: true,
		}
	default:
		return &RelayOperationError{
			Code:      "tool_execution_failed",
			Message:   message,
			Retryable: true,
		}
	}
}

func (c *Client) backoffDelay(attempt int) time.Duration {
	delay := float64(baseReconnectDelay) * math.Pow(reconnectMultiplier, float64(attempt-1))
	if delay > float64(maxReconnectDelay) {
		delay = float64(maxReconnectDelay)
	}
	jitter := delay * jitterFraction * (rand.Float64()*2 - 1)
	d := time.Duration(delay + jitter)
	if d < baseReconnectDelay {
		d = baseReconnectDelay
	}
	return d
}

func (c *Client) writeCatalogSync(conn *websocket.Conn) error {
	c.mu.Lock()
	syncSources := c.syncSources
	exposures := c.exposures
	c.mu.Unlock()

	return c.writeJSON(conn, CatalogSyncMessage{
		Type:        "catalog.sync",
		SyncSources: syncSources,
		Exposures:   exposures,
	})
}

func (c *Client) writeJSON(conn *websocket.Conn, payload interface{}) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return conn.WriteJSON(payload)
}

func (c *Client) setConnection(conn *websocket.Conn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn = conn
}

func (c *Client) clearConnection(conn *websocket.Conn) {
	c.mu.Lock()
	if c.conn == conn {
		c.conn = nil
	}
	waitCh := c.catalogSyncCh
	c.catalogSyncCh = nil
	c.mu.Unlock()

	if waitCh != nil {
		select {
		case waitCh <- fmt.Errorf("relay connection closed"):
		default:
		}
	}
}

func (c *Client) getConnection() *websocket.Conn {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn
}

func (c *Client) resolveCatalogSync(err error) {
	c.mu.Lock()
	waitCh := c.catalogSyncCh
	c.catalogSyncCh = nil
	c.mu.Unlock()

	if waitCh == nil {
		return
	}

	select {
	case waitCh <- err:
	default:
	}
}

func (c *Client) clearCatalogSyncWait(waitCh chan error) {
	c.mu.Lock()
	if c.catalogSyncCh == waitCh {
		c.catalogSyncCh = nil
	}
	c.mu.Unlock()
}
