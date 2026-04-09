package commandline

import (
	"strings"
	"testing"
)

func TestCappedOutputWriterTruncatesLargeWrites(t *testing.T) {
	t.Parallel()

	writer := newCappedOutputWriter(16)
	if _, err := writer.Write([]byte("1234567890")); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if _, err := writer.Write([]byte("abcdefghij")); err != nil {
		t.Fatalf("second write: %v", err)
	}

	if !writer.truncated() {
		t.Fatalf("expected writer to report truncation")
	}
	text := writer.textWithNotice(0)
	if !strings.Contains(text, "output truncated") {
		t.Fatalf("expected truncation notice, got %q", text)
	}
}

func TestCommandTaskOutputTextUsesBoundedHistory(t *testing.T) {
	t.Parallel()

	task := &commandTask{}
	longLine := strings.Repeat("x", maxCommandOutputChunkBytes+512)

	for i := 0; i < maxTaskOutputChunks+3; i++ {
		chunk := task.appendOutput("stdout", longLine)
		if len(chunk.Text) > maxCommandOutputChunkBytes {
			t.Fatalf("expected stored chunk text to be capped at %d bytes, got %d", maxCommandOutputChunkBytes, len(chunk.Text))
		}
	}

	if len(task.output) != maxTaskOutputChunks {
		t.Fatalf("expected output history capped at %d chunks, got %d", maxTaskOutputChunks, len(task.output))
	}
	if task.droppedStdout != 3 {
		t.Fatalf("expected 3 dropped stdout chunks, got %d", task.droppedStdout)
	}

	text, truncated := task.outputText("stdout")
	if !truncated {
		t.Fatalf("expected bounded task output to report truncation")
	}
	if !strings.Contains(text, "chunk truncated") {
		t.Fatalf("expected per-chunk truncation marker, got %q", text)
	}
	if !strings.Contains(text, "dropped 3 older output chunk(s)") {
		t.Fatalf("expected dropped chunk notice, got %q", text)
	}
}
