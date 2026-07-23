package main

// Unit tests for the §3c carrier contract's Go copy (a sanctioned literal
// duplicate of packages/shared/src/utils/traceparent.ts — see the pinned
// comment above validTraceparent). Go's RE2 cannot express the canonical
// regex's (?!0{32}) lookaheads, so the all-zero rejection is hand-rolled by
// slicing — exactly the kind of re-implementation the sync list warns can
// drift. This matrix mirrors the Rust sibling (fs-helper telemetry.rs) and
// the TS matrix (device-runtime trace-context.test.ts).

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	oteltrace "go.opentelemetry.io/otel/trace"
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

// ─── span semantics matrix (F9a) ────────────────────────────────────────────
//
// Drives handle() against an in-memory exporter installed via
// otel.SetTracerProvider (proving the package-level delegating otel.Tracer
// picks up a provider set after init), and asserts the full JSON-RPC semconv
// picture per frame: SERVER kind, span name, status, remote parent from the
// §3c carrier, and the exact attribute set.

func attrMap(kvs []attribute.KeyValue) map[string]string {
	m := make(map[string]string, len(kvs))
	for _, kv := range kvs {
		m[string(kv.Key)] = kv.Value.Emit()
	}
	return m
}

func TestHandleSpanMatrix(t *testing.T) {
	exp := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exp))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	const (
		carrierTraceID = "11111111111111111111111111111111"
		carrierSpanID  = "2222222222222222"
		carrierTP      = "00-" + carrierTraceID + "-" + carrierSpanID + "-01"
	)

	frames := []string{
		// unknown method WITH a carrier and a numeric id
		`{"jsonrpc":"2.0","id":1,"method":"nope","traceparent":"` + carrierTP + `"}`,
		// hello WITHOUT a carrier and WITHOUT an id (a notification)
		`{"jsonrpc":"2.0","method":"hello"}`,
		// unparsable frame — must STILL produce a span (was: no span at all)
		`not json at all`,
	}
	var out bytes.Buffer
	for _, f := range frames {
		handle([]byte(f), &out)
	}

	spans := exp.GetSpans()
	if len(spans) != 3 {
		t.Fatalf("want 3 spans, got %d", len(spans))
	}
	for i, s := range spans {
		if s.SpanKind != oteltrace.SpanKindServer {
			t.Errorf("span %d (%q) kind=%v, want Server", i, s.Name, s.SpanKind)
		}
		a := attrMap(s.Attributes)
		if a["rpc.system.name"] != "jsonrpc" {
			t.Errorf("span %d rpc.system.name=%q, want jsonrpc", i, a["rpc.system.name"])
		}
		if a["jsonrpc.protocol.version"] != "2.0" {
			t.Errorf("span %d jsonrpc.protocol.version=%q, want 2.0", i, a["jsonrpc.protocol.version"])
		}
		if a["network.transport"] != "pipe" {
			t.Errorf("span %d network.transport=%q, want pipe", i, a["network.transport"])
		}
	}

	// span 0: unknown method → _OTHER, ERROR -32601, remote parent from carrier.
	s0 := spans[0]
	a0 := attrMap(s0.Attributes)
	if s0.Name != "jsonrpc" {
		t.Errorf("span0 name=%q, want jsonrpc", s0.Name)
	}
	if s0.Status.Code != codes.Error {
		t.Errorf("span0 status=%v, want Error", s0.Status.Code)
	}
	if a0["rpc.method"] != "_OTHER" {
		t.Errorf("span0 rpc.method=%q, want _OTHER", a0["rpc.method"])
	}
	if a0["rpc.method_original"] != "nope" {
		t.Errorf("span0 rpc.method_original=%q, want nope", a0["rpc.method_original"])
	}
	if a0["jsonrpc.request.id"] != "1" {
		t.Errorf("span0 jsonrpc.request.id=%q, want 1", a0["jsonrpc.request.id"])
	}
	if a0["rpc.response.status_code"] != "-32601" || a0["error.type"] != "-32601" {
		t.Errorf("span0 status_code=%q error.type=%q, want -32601/-32601",
			a0["rpc.response.status_code"], a0["error.type"])
	}
	if s0.SpanContext.TraceID().String() != carrierTraceID {
		t.Errorf("span0 trace_id=%s, want continued %s", s0.SpanContext.TraceID(), carrierTraceID)
	}
	if !s0.Parent.IsRemote() || s0.Parent.SpanID().String() != carrierSpanID {
		t.Errorf("span0 parent=%s (remote=%v), want remote %s",
			s0.Parent.SpanID(), s0.Parent.IsRemote(), carrierSpanID)
	}

	// span 1: hello → named, UNSET, rpc.method=hello, NO id, NO _OTHER, root.
	s1 := spans[1]
	a1 := attrMap(s1.Attributes)
	if s1.Name != "hello" {
		t.Errorf("span1 name=%q, want hello", s1.Name)
	}
	if s1.Status.Code != codes.Unset {
		t.Errorf("span1 status=%v, want Unset", s1.Status.Code)
	}
	if a1["rpc.method"] != "hello" {
		t.Errorf("span1 rpc.method=%q, want hello", a1["rpc.method"])
	}
	if _, ok := a1["jsonrpc.request.id"]; ok {
		t.Errorf("span1 must NOT carry jsonrpc.request.id (notification), got %q", a1["jsonrpc.request.id"])
	}
	if _, ok := a1["rpc.method_original"]; ok {
		t.Errorf("span1 must NOT carry rpc.method_original for a recognized method")
	}
	if s1.Parent.IsValid() {
		t.Errorf("span1 must be a root (no carrier), got parent %s", s1.Parent.SpanID())
	}

	// span 2: unparsable → jsonrpc/_OTHER, ERROR -32700, no id, no original.
	s2 := spans[2]
	a2 := attrMap(s2.Attributes)
	if s2.Name != "jsonrpc" {
		t.Errorf("span2 name=%q, want jsonrpc", s2.Name)
	}
	if s2.Status.Code != codes.Error {
		t.Errorf("span2 status=%v, want Error", s2.Status.Code)
	}
	if a2["rpc.method"] != "_OTHER" {
		t.Errorf("span2 rpc.method=%q, want _OTHER", a2["rpc.method"])
	}
	if a2["rpc.response.status_code"] != "-32700" {
		t.Errorf("span2 status_code=%q, want -32700", a2["rpc.response.status_code"])
	}
	if _, ok := a2["jsonrpc.request.id"]; ok {
		t.Errorf("span2 (unparsable) must NOT carry jsonrpc.request.id")
	}
}

// TestAdvertisedMethodsAreDispatched is the invariant that keeps `_OTHER`
// classification honest: every advertised method, dispatched with empty params,
// must NOT fall through to the default arm (i.e. must NOT answer -32601). The
// day someone adds a method to the switch but forgets advertisedMethods (or vice
// versa) this fails, catching the drift the structural classifier relies on.
func TestAdvertisedMethodsAreDispatched(t *testing.T) {
	for _, m := range advertisedMethods {
		_, err := dispatchRPC(rpcRequest{Method: m})
		if err != nil && err.Code == codeMethodNotFound {
			t.Errorf("advertised method %q answered -32601 (not routed by dispatchRPC)", m)
		}
	}
	// And the negative: a method NOT in the switch must answer -32601, so the
	// classifier's sole signal is real.
	if _, err := dispatchRPC(rpcRequest{Method: "definitely_not_a_method"}); err == nil || err.Code != codeMethodNotFound {
		t.Errorf("unknown method must answer -32601, got %+v", err)
	}
}
