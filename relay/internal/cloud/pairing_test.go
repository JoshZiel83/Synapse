package cloud

import (
	"context"
	"strings"
	"testing"

	"github.com/PekingSpades/Synapse/relay/internal/config"
)

func TestClaimPairingUsesDefaultPrivateKeyPathWhenMissing(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	_, _, err := ClaimPairing(context.Background(), config.RelayConfig{
		ServerBaseURL: "https://example.com/dashboard/plugins?relayPairing=test&code=ABCD-1234-EFGH",
	}, "ABCD-1234-EFGH", "")
	if err == nil {
		t.Fatal("expected claim pairing to fail without a reachable server")
	}
	if strings.Contains(err.Error(), "private key path is required") {
		t.Fatalf("expected default private key path fallback, got error %q", err.Error())
	}
}
