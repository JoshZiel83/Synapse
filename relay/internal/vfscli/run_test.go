package vfscli

import (
	"testing"

	"github.com/PekingSpades/Synapse/relay/internal/vfs"
)

func TestWatchTreatAsText(t *testing.T) {
	if !watchTreatAsText("application/json", []byte(`{"ok":true}`)) {
		t.Fatalf("expected json payload to be treated as text")
	}
	if watchTreatAsText("image/png", []byte{0x89, 0x50, 0x4e, 0x47, 0x00, 0x01}) {
		t.Fatalf("expected png-like payload to be treated as binary")
	}
}

func TestNewWatchEventEncodesTextAndBinary(t *testing.T) {
	textEvent := newWatchEvent("/demo.txt", vfs.ReadResult{
		MimeType: "text/plain; charset=utf-8",
		Data:     []byte("hello"),
	})
	if textEvent.Encoding != "utf-8" || textEvent.Text != "hello" {
		t.Fatalf("text watch event = %+v", textEvent)
	}

	binaryEvent := newWatchEvent("/demo.bin", vfs.ReadResult{
		MimeType: "application/octet-stream",
		Data:     []byte{0x00, 0x01, 0x02},
	})
	if binaryEvent.Encoding != "base64" || binaryEvent.DataBase64 == "" {
		t.Fatalf("binary watch event = %+v", binaryEvent)
	}
}
