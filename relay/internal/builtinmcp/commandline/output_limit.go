package commandline

import (
	"bytes"
	"fmt"
	"strings"
)

const (
	maxCommandOutputBytes      = 256 * 1024
	maxCommandOutputChunkBytes = 16 * 1024
)

type cappedOutputWriter struct {
	limit int
	total int
	buf   bytes.Buffer
}

func newCappedOutputWriter(limit int) *cappedOutputWriter {
	if limit <= 0 {
		limit = maxCommandOutputBytes
	}
	return &cappedOutputWriter{limit: limit}
}

func (w *cappedOutputWriter) Write(p []byte) (int, error) {
	w.total += len(p)
	if w.buf.Len() >= w.limit {
		return len(p), nil
	}

	remaining := w.limit - w.buf.Len()
	if remaining > len(p) {
		remaining = len(p)
	}
	if remaining > 0 {
		if _, err := w.buf.Write(p[:remaining]); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

func (w *cappedOutputWriter) appendLine(text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	if w.buf.Len() > 0 {
		_, _ = w.Write([]byte("\n"))
	}
	_, _ = w.Write([]byte(text))
}

func (w *cappedOutputWriter) omittedBytes() int {
	if w.total <= w.buf.Len() {
		return 0
	}
	return w.total - w.buf.Len()
}

func (w *cappedOutputWriter) truncated() bool {
	return w.omittedBytes() > 0
}

func (w *cappedOutputWriter) textWithNotice(droppedChunks int) string {
	text := normalizeOutput(w.buf.String())
	noticeParts := make([]string, 0, 2)
	if omitted := w.omittedBytes(); omitted > 0 {
		noticeParts = append(noticeParts, fmt.Sprintf("output truncated after %d bytes; omitted %d byte(s)", w.limit, omitted))
	}
	if droppedChunks > 0 {
		noticeParts = append(noticeParts, fmt.Sprintf("dropped %d older output chunk(s)", droppedChunks))
	}
	if len(noticeParts) == 0 {
		return text
	}

	notice := "[" + strings.Join(noticeParts, "; ") + "]"
	if text == "" {
		return notice
	}
	return text + "\n\n" + notice
}

func truncateOutputChunkText(text string) string {
	if len(text) <= maxCommandOutputChunkBytes {
		return text
	}
	omitted := len(text) - maxCommandOutputChunkBytes
	if maxCommandOutputChunkBytes <= 64 {
		return text[:maxCommandOutputChunkBytes]
	}
	suffix := fmt.Sprintf("...[chunk truncated, omitted %d byte(s)]", omitted)
	prefixLimit := maxCommandOutputChunkBytes - len(suffix)
	if prefixLimit < 0 {
		prefixLimit = 0
	}
	return text[:prefixLimit] + suffix
}
