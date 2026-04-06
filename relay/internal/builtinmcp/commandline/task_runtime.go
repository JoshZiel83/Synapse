package commandline

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/builtinmcp/core"
)

const (
	maxTaskOutputChunks      = 512
	maxTaskOutputReadLimit   = 200
	taskOutputScannerBufSize = 1024 * 1024
)

type commandInvocation struct {
	runtimeName string
	binaryPath  string
	args        []string
	cwd         string
	env         map[string]string
	timeout     resolvedTimeout
}

type commandTask struct {
	id                 string
	toolName           string
	supportsCancel     bool
	supportsOutputTail bool

	mu              sync.RWMutex
	status          core.TaskStatus
	statusMessage   string
	startedAt       time.Time
	updatedAt       time.Time
	completedAt     time.Time
	lastOutputSeq   int64
	output          []core.TaskOutputChunk
	droppedStdout   int
	droppedStderr   int
	droppedSystem   int
	result          *core.CallResult
	cancelReason    string
	cancelRequested bool
	cancel          context.CancelFunc
	cmd             *exec.Cmd
}

func previewTaskLogText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 || len(value) <= limit {
		return value
	}
	if limit <= 3 {
		return value[:limit]
	}
	return value[:limit-3] + "..."
}

func taskCommandPreview(binaryPath string, args []string) string {
	parts := append([]string{binaryPath}, args...)
	return strings.Join(parts, " ")
}

func taskEnvKeys(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func logCommandTaskf(taskID string, format string, args ...interface{}) {
	log.Printf("[commandline-task] task=%s %s", taskID, fmt.Sprintf(format, args...))
}

func (s *Server) StartTask(
	_ context.Context,
	toolName string,
	args map[string]interface{},
	requestedTaskID string,
) (core.TaskSnapshot, error) {
	taskID := strings.TrimSpace(requestedTaskID)
	if taskID == "" {
		taskID = fmt.Sprintf("cmd-%d", time.Now().UnixNano())
	}

	s.taskMu.Lock()
	if existing, ok := s.tasks[taskID]; ok {
		snapshot := existing.snapshot()
		s.taskMu.Unlock()
		logCommandTaskf(taskID, "reusing existing task status=%s tool=%s", snapshot.Status, snapshot.ToolName)
		return snapshot, nil
	}

	invocation, err := s.prepareInvocation(toolName, args)
	if err != nil {
		s.taskMu.Unlock()
		return core.TaskSnapshot{}, err
	}

	taskCtx := context.Background()
	cancel := func() {}
	if invocation.timeout.Effective > 0 {
		taskCtx, cancel = context.WithTimeout(context.Background(), invocation.timeout.Effective)
	} else {
		taskCtx, cancel = context.WithCancel(context.Background())
	}

	task := &commandTask{
		id:                 taskID,
		toolName:           toolName,
		supportsCancel:     true,
		supportsOutputTail: true,
		status:             core.TaskStatusWorking,
		statusMessage:      fmt.Sprintf("%s queued.", invocation.runtimeName),
		updatedAt:          time.Now().UTC(),
		cancel:             cancel,
	}
	s.tasks[taskID] = task
	s.pruneFinishedTasksLocked()
	s.taskMu.Unlock()

	logCommandTaskf(
		taskID,
		"queued tool=%s runtime=%s cwd=%q timeout=%s envKeys=%v command=%q",
		toolName,
		invocation.runtimeName,
		invocation.cwd,
		invocation.timeout.Effective,
		taskEnvKeys(invocation.env),
		taskCommandPreview(invocation.binaryPath, invocation.args),
	)

	go s.runTask(taskCtx, task, invocation)

	return task.snapshot(), nil
}

func (s *Server) GetTask(taskID string) (core.TaskSnapshot, error) {
	s.taskMu.RLock()
	task, ok := s.tasks[strings.TrimSpace(taskID)]
	s.taskMu.RUnlock()
	if !ok {
		return core.TaskSnapshot{}, core.ErrTaskNotFound
	}
	return task.snapshot(), nil
}

func (s *Server) ReadTaskOutput(
	taskID string,
	afterSeq int64,
	limit int,
	stream string,
) ([]core.TaskOutputChunk, error) {
	s.taskMu.RLock()
	task, ok := s.tasks[strings.TrimSpace(taskID)]
	s.taskMu.RUnlock()
	if !ok {
		return nil, core.ErrTaskNotFound
	}
	return task.readOutput(afterSeq, limit, stream), nil
}

func (s *Server) CancelTask(taskID string, reason string) error {
	s.taskMu.RLock()
	task, ok := s.tasks[strings.TrimSpace(taskID)]
	s.taskMu.RUnlock()
	if !ok {
		return core.ErrTaskNotFound
	}
	task.requestCancel(reason)
	return nil
}

func (s *Server) prepareInvocation(
	toolName string,
	args map[string]interface{},
) (commandInvocation, error) {
	switch toolName {
	case "bash":
		binaryPath, err := s.resolveBashBinary()
		if err != nil {
			return commandInvocation{}, err
		}
		command, err := stringArg(args, "command", true)
		if err != nil {
			return commandInvocation{}, err
		}
		cwd, err := s.resolveWorkingDir(args)
		if err != nil {
			return commandInvocation{}, err
		}
		timeout, err := s.resolveTimeout(args)
		if err != nil {
			return commandInvocation{}, err
		}
		env, err := mapArg(args, "env")
		if err != nil {
			return commandInvocation{}, err
		}
		return commandInvocation{
			runtimeName: "bash",
			binaryPath:  binaryPath,
			args:        []string{"-lc", command},
			cwd:         cwd,
			env:         env,
			timeout:     timeout,
		}, nil
	default:
		return commandInvocation{}, fmt.Errorf("unknown task-backed tool: %s", toolName)
	}
}

func (s *Server) runTask(ctx context.Context, task *commandTask, invocation commandInvocation) {
	defer task.cancel()

	cmd := exec.Command(invocation.binaryPath, invocation.args...)
	applyPlatformProcessAttrs(cmd)
	cmd.Dir = invocation.cwd
	cmd.Env = s.environment(invocation.env)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		task.complete(core.TaskStatusFailed, fmt.Sprintf("%s failed to prepare stdout: %v", invocation.runtimeName, err), pointerCallResult(errorResult(err.Error())))
		return
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		task.complete(core.TaskStatusFailed, fmt.Sprintf("%s failed to prepare stderr: %v", invocation.runtimeName, err), pointerCallResult(errorResult(err.Error())))
		return
	}

	if err := cmd.Start(); err != nil {
		task.complete(core.TaskStatusFailed, fmt.Sprintf("%s failed to start: %v", invocation.runtimeName, err), pointerCallResult(errorResult(fmt.Sprintf("%s failed to start: %v", invocation.runtimeName, err))))
		return
	}

	task.markStarted(invocation.runtimeName, cmd)
	pid := -1
	if cmd.Process != nil {
		pid = cmd.Process.Pid
	}
	logCommandTaskf(
		task.id,
		"started tool=%s runtime=%s pid=%d cwd=%q timeout=%s command=%q",
		task.toolName,
		invocation.runtimeName,
		pid,
		invocation.cwd,
		invocation.timeout.Effective,
		taskCommandPreview(invocation.binaryPath, invocation.args),
	)

	var readerWG sync.WaitGroup
	readerWG.Add(2)
	go task.captureOutput(&readerWG, stdoutPipe, "stdout")
	go task.captureOutput(&readerWG, stderrPipe, "stderr")

	waitDone := make(chan error, 1)
	go func() {
		waitDone <- cmd.Wait()
	}()

	select {
	case <-ctx.Done():
		terminateManagedProcess(cmd)
	case <-waitDone:
	}

	waitErr := <-waitDone
	readerWG.Wait()

	stdoutText, stdoutTruncated := task.outputText("stdout")
	stderrText, stderrTruncated := task.outputText("stderr")
	status, message, result := buildTaskResult(
		invocation.runtimeName,
		invocation.binaryPath,
		invocation.args,
		invocation.cwd,
		invocation.timeout,
		task.cancelWasRequested(),
		ctx.Err(),
		waitErr,
		stdoutText,
		stderrText,
		stdoutTruncated,
		stderrTruncated,
	)
	task.complete(status, message, pointerCallResult(result))
}

func (s *Server) pruneFinishedTasksLocked() {
	if len(s.tasks) <= 256 {
		return
	}

	cutoff := time.Now().UTC().Add(-24 * time.Hour)
	for id, task := range s.tasks {
		task.mu.RLock()
		done := task.status == core.TaskStatusCompleted ||
			task.status == core.TaskStatusFailed ||
			task.status == core.TaskStatusCancelled
		completedAt := task.completedAt
		task.mu.RUnlock()
		if done && !completedAt.IsZero() && completedAt.Before(cutoff) {
			delete(s.tasks, id)
		}
	}
}

func (t *commandTask) markStarted(runtimeName string, cmd *exec.Cmd) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cmd = cmd
	now := time.Now().UTC()
	t.startedAt = now
	t.updatedAt = now
	t.status = core.TaskStatusWorking
	t.statusMessage = fmt.Sprintf("%s started.", runtimeName)
}

func (t *commandTask) captureOutput(wg *sync.WaitGroup, reader io.ReadCloser, stream string) {
	defer wg.Done()
	defer reader.Close()

	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), taskOutputScannerBufSize)
	for scanner.Scan() {
		text := truncateOutputChunkText(normalizeOutput(scanner.Text()))
		if text == "" {
			continue
		}
		chunk := t.appendOutput(stream, text)
		logCommandTaskf(
			t.id,
			"output tool=%s stream=%s seq=%d text=%q",
			t.toolName,
			chunk.Stream,
			chunk.Seq,
			chunk.Text,
		)
	}
	if err := scanner.Err(); err != nil {
		t.appendOutput("system", fmt.Sprintf("%s reader error: %v", stream, err))
		logCommandTaskf(t.id, "reader error tool=%s stream=%s err=%v", t.toolName, stream, err)
	}
}

func (t *commandTask) appendOutput(stream, text string) core.TaskOutputChunk {
	t.mu.Lock()
	defer t.mu.Unlock()

	text = truncateOutputChunkText(normalizeOutput(text))

	now := time.Now().UTC()
	t.lastOutputSeq++
	chunk := core.TaskOutputChunk{
		Seq:       t.lastOutputSeq,
		Stream:    stream,
		Text:      text,
		CreatedAt: now.Format(time.RFC3339Nano),
	}
	t.output = append(t.output, chunk)
	if len(t.output) > maxTaskOutputChunks {
		dropped := t.output[0]
		t.output = append([]core.TaskOutputChunk(nil), t.output[1:]...)
		switch dropped.Stream {
		case "stdout":
			t.droppedStdout++
		case "stderr":
			t.droppedStderr++
		default:
			t.droppedSystem++
		}
	}
	t.updatedAt = now
	return chunk
}

func (t *commandTask) requestCancel(reason string) {
	t.mu.Lock()
	if t.status == core.TaskStatusCompleted || t.status == core.TaskStatusFailed || t.status == core.TaskStatusCancelled {
		t.mu.Unlock()
		return
	}
	t.cancelRequested = true
	t.cancelReason = strings.TrimSpace(reason)
	if t.cancelReason == "" {
		t.cancelReason = "Cancellation requested."
	}
	t.statusMessage = t.cancelReason
	t.updatedAt = time.Now().UTC()
	cancel := t.cancel
	t.mu.Unlock()

	logCommandTaskf(t.id, "cancel requested tool=%s reason=%q", t.toolName, t.cancelReason)

	if cancel != nil {
		cancel()
	}
}

func (t *commandTask) cancelWasRequested() bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.cancelRequested
}

func (t *commandTask) currentCmd() *exec.Cmd {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.cmd
}

func (t *commandTask) isTerminal() bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.status == core.TaskStatusCompleted ||
		t.status == core.TaskStatusFailed ||
		t.status == core.TaskStatusCancelled
}

func (t *commandTask) outputText(stream string) (string, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()

	writer := newCappedOutputWriter(maxCommandOutputBytes)
	droppedChunks := 0
	switch stream {
	case "stdout":
		droppedChunks = t.droppedStdout
	case "stderr":
		droppedChunks = t.droppedStderr
	default:
		return "", false
	}
	for _, chunk := range t.output {
		if chunk.Stream != stream {
			continue
		}
		writer.appendLine(chunk.Text)
	}
	return writer.textWithNotice(droppedChunks), writer.truncated() || droppedChunks > 0
}

func (t *commandTask) complete(status core.TaskStatus, message string, result *core.CallResult) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now().UTC()
	t.status = status
	t.statusMessage = message
	t.updatedAt = now
	t.completedAt = now
	t.result = result
	t.cmd = nil
	resultError := false
	if result != nil {
		resultError = result.IsError
	}
	logCommandTaskf(
		t.id,
		"completed tool=%s status=%s resultError=%t outputSeq=%d message=%q stdoutDropped=%d stderrDropped=%d resultPreview=%q",
		t.toolName,
		status,
		resultError,
		t.lastOutputSeq,
		message,
		t.droppedStdout,
		t.droppedStderr,
		previewTaskLogText(previewLogResult(result), 600),
	)
}

func (t *commandTask) snapshot() core.TaskSnapshot {
	t.mu.RLock()
	defer t.mu.RUnlock()

	snapshot := core.TaskSnapshot{
		TaskID:             t.id,
		ToolName:           t.toolName,
		Status:             t.status,
		StatusMessage:      t.statusMessage,
		SupportsCancel:     t.supportsCancel,
		SupportsOutputTail: t.supportsOutputTail,
		LastOutputSeq:      t.lastOutputSeq,
	}
	if !t.startedAt.IsZero() {
		snapshot.StartedAt = t.startedAt.Format(time.RFC3339Nano)
	}
	if !t.updatedAt.IsZero() {
		snapshot.UpdatedAt = t.updatedAt.Format(time.RFC3339Nano)
	}
	if !t.completedAt.IsZero() {
		snapshot.CompletedAt = t.completedAt.Format(time.RFC3339Nano)
	}
	if t.result != nil {
		cloned := *t.result
		snapshot.Result = &cloned
	}
	return snapshot
}

func (t *commandTask) readOutput(afterSeq int64, limit int, stream string) []core.TaskOutputChunk {
	if limit <= 0 {
		limit = 20
	}
	if limit > maxTaskOutputReadLimit {
		limit = maxTaskOutputReadLimit
	}
	stream = strings.TrimSpace(strings.ToLower(stream))

	t.mu.RLock()
	defer t.mu.RUnlock()

	filtered := make([]core.TaskOutputChunk, 0, limit)
	for _, chunk := range t.output {
		if chunk.Seq <= afterSeq {
			continue
		}
		if stream != "" && stream != "combined" && chunk.Stream != stream {
			continue
		}
		filtered = append(filtered, chunk)
	}

	if afterSeq > 0 || len(filtered) <= limit {
		return append([]core.TaskOutputChunk(nil), filtered...)
	}
	return append([]core.TaskOutputChunk(nil), filtered[len(filtered)-limit:]...)
}

func pointerCallResult(value core.CallResult) *core.CallResult {
	cloned := value
	return &cloned
}

func previewLogResult(result *core.CallResult) string {
	if result == nil {
		return ""
	}
	if len(result.Content) > 0 {
		return previewTaskLogText(fmt.Sprint(result.Content[0]), 600)
	}
	return previewTaskLogText(fmt.Sprint(result.StructuredContent), 600)
}

func buildTaskResult(
	runtimeName string,
	binaryPath string,
	args []string,
	cwd string,
	timeout resolvedTimeout,
	cancelRequested bool,
	ctxErr error,
	runErr error,
	stdoutText string,
	stderrText string,
	stdoutTruncated bool,
	stderrTruncated bool,
) (core.TaskStatus, string, core.CallResult) {
	exitCode := 0
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}

	statusText := fmt.Sprintf("%s exited with code %d.", runtimeName, exitCode)
	switch {
	case cancelRequested || errors.Is(ctxErr, context.Canceled):
		statusText = fmt.Sprintf("%s was canceled.", runtimeName)
	case errors.Is(ctxErr, context.DeadlineExceeded):
		statusText = fmt.Sprintf("%s timed out after %s.", runtimeName, timeout.Effective)
	case runErr != nil && exitCode < 0:
		statusText = fmt.Sprintf("%s failed to start: %v", runtimeName, runErr)
	}

	details := []string{}
	if timeout.UsedDefault {
		details = append(details, fmt.Sprintf("Using relay default timeout of %s.", timeout.Effective))
	} else if timeout.Capped {
		details = append(details, fmt.Sprintf("Requested timeout %s exceeded relay max %s. Using %s.", timeout.Requested, timeout.Max, timeout.Effective))
	}
	details = append(details, statusText)
	if stdoutText != "" {
		details = append(details, "stdout:\n"+stdoutText)
	}
	if stderrText != "" {
		details = append(details, "stderr:\n"+stderrText)
	}

	structured := map[string]interface{}{
		"runtime":             runtimeName,
		"command":             append([]string{binaryPath}, args...),
		"cwd":                 cwd,
		"exitCode":            exitCode,
		"stdout":              stdoutText,
		"stdoutTruncated":     stdoutTruncated,
		"stderr":              stderrText,
		"stderrTruncated":     stderrTruncated,
		"timedOut":            errors.Is(ctxErr, context.DeadlineExceeded),
		"canceled":            cancelRequested || errors.Is(ctxErr, context.Canceled),
		"requestedTimeoutSec": timeout.Requested.Seconds(),
		"effectiveTimeoutSec": timeout.Effective.Seconds(),
		"maxTimeoutSec":       timeout.Max.Seconds(),
		"usedDefaultTimeout":  timeout.UsedDefault,
		"timeoutCapped":       timeout.Capped,
		"assetVersion":        "",
	}
	if runErr != nil {
		structured["error"] = runErr.Error()
	}

	result := core.CallResult{
		Content: []interface{}{
			core.Text(strings.Join(details, "\n\n")),
		},
		StructuredContent: structured,
		IsError:           runErr != nil || cancelRequested || errors.Is(ctxErr, context.DeadlineExceeded),
	}

	switch {
	case cancelRequested || errors.Is(ctxErr, context.Canceled):
		return core.TaskStatusCancelled, statusText, result
	case result.IsError:
		return core.TaskStatusFailed, statusText, result
	default:
		return core.TaskStatusCompleted, statusText, result
	}
}
