package main

// Unit tests for the §3c carrier contract's Go copy (a sanctioned literal
// duplicate of packages/shared/src/utils/traceparent.ts — see the pinned
// comment above validTraceparent). Go's RE2 cannot express the canonical
// regex's (?!0{32}) lookaheads, so the all-zero rejection is hand-rolled by
// slicing — exactly the kind of re-implementation the sync list warns can
// drift. This matrix mirrors the Rust sibling (fs-helper telemetry.rs) and
// the TS matrix (device-runtime trace-context.test.ts).

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestValidTraceparentMatchesThePinnedRegex(t *testing.T) {
	valid := []string{
		"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00",
	}
	for _, v := range valid {
		if !validTraceparent(v) {
			t.Errorf("expected valid: %q", v)
		}
	}

	invalid := map[string]string{
		"wrong version":      "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		"uppercase hex":      "00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01",
		"all-zero trace-id":  "00-00000000000000000000000000000000-b7ad6b7169203331-01",
		"all-zero span-id":   "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01",
		"garbage":            "garbage",
		"empty":              "",
		"trailing extra":     "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra",
		"truncated":          "00-0af7651916cd43dd8448eb211c80319c-b7ad6b716920333-01",
		"non-hex in span-id": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b716920333g-01",
	}
	for name, v := range invalid {
		if validTraceparent(v) {
			t.Errorf("expected invalid (%s): %q", name, v)
		}
	}
}

func TestFrameCarrierTracestateGating(t *testing.T) {
	const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

	// Malformed traceparent ⇒ nil carrier (degrade to root span), even with a
	// perfectly fine tracestate — tracestate is honored ONLY alongside a valid
	// traceparent (§3c receiver rule).
	if c := frameCarrier("garbage", "es=s:1.0"); c != nil {
		t.Errorf("malformed traceparent must yield a nil carrier, got %v", c)
	}
	if c := frameCarrier("", ""); c != nil {
		t.Errorf("empty traceparent must yield a nil carrier, got %v", c)
	}

	// Valid traceparent, no tracestate ⇒ one-key carrier.
	c := frameCarrier(tp, "")
	if c == nil || c["traceparent"] != tp {
		t.Fatalf("valid traceparent must ride in the carrier, got %v", c)
	}
	if _, ok := c["tracestate"]; ok {
		t.Errorf("empty tracestate must be ABSENT, got %v", c)
	}

	// Valid tracestate at the cap (512) rides along verbatim.
	atCap := "es=" + strings.Repeat("a", maxTracestateLength-3)
	if len(atCap) != maxTracestateLength {
		t.Fatalf("fixture bug: len=%d", len(atCap))
	}
	c = frameCarrier(tp, atCap)
	if c["tracestate"] != atCap {
		t.Errorf("tracestate at the cap must be included")
	}

	// Oversized (cap+1) tracestate is dropped while the traceparent survives.
	over := atCap + "a"
	c = frameCarrier(tp, over)
	if c == nil || c["traceparent"] != tp {
		t.Fatalf("oversized tracestate must not invalidate the traceparent")
	}
	if _, ok := c["tracestate"]; ok {
		t.Errorf("tracestate over MAX_TRACESTATE_LENGTH must be dropped")
	}
}

// TestGoldenVectors drives the SAME cross-language JSON the TS and Rust tests
// read, so all three languages assert identical behaviour on identical inputs.
// validTraceparent must match `accept`; frameCarrier's tracestate decision
// (non-empty + within the cap — the ABNF whole-or-nothing is the OTel library's
// job, not this helper's) must match `capOnly`.
func TestGoldenVectors(t *testing.T) {
	const vectorsPath = "../../../../packages/shared/src/utils/traceparent-vectors.json"
	raw, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatalf("read golden vectors %s: %v", vectorsPath, err)
	}
	var vectors struct {
		Traceparent []struct {
			V      string `json:"v"`
			Accept bool   `json:"accept"`
			Note   string `json:"note"`
		} `json:"traceparent"`
		Tracestate []struct {
			V       string `json:"v"`
			Gate    bool   `json:"gate"`
			CapOnly bool   `json:"capOnly"`
			Note    string `json:"note"`
		} `json:"tracestate"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("parse golden vectors: %v", err)
	}
	if len(vectors.Traceparent) == 0 || len(vectors.Tracestate) == 0 {
		t.Fatalf("golden vectors are empty (traceparent=%d tracestate=%d)",
			len(vectors.Traceparent), len(vectors.Tracestate))
	}

	for _, v := range vectors.Traceparent {
		if got := validTraceparent(v.V); got != v.Accept {
			t.Errorf("traceparent %q (%s): validTraceparent=%v want %v", v.V, v.Note, got, v.Accept)
		}
	}

	const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	for _, v := range vectors.Tracestate {
		carrier := frameCarrier(tp, v.V)
		_, present := carrier["tracestate"]
		if present != v.CapOnly {
			t.Errorf("tracestate %q (%s): frameCarrier tracestate present=%v want capOnly=%v",
				v.V, v.Note, present, v.CapOnly)
		}
	}
}
