package cloud

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"testing"
	"time"
)

func TestValidateSecureRelayURLRejectsRemoteInsecure(t *testing.T) {
	if err := validateSecureRelayURL("http://relay.example.com"); err == nil {
		t.Fatalf("expected remote http relay URL to be rejected")
	}
	if err := validateSecureRelayURL("ws://relay.example.com/ws/relay"); err == nil {
		t.Fatalf("expected remote ws relay URL to be rejected")
	}
	if err := validateSecureRelayURL("http://127.0.0.1:3001"); err != nil {
		t.Fatalf("expected loopback http relay URL to be allowed: %v", err)
	}
}

func TestBuildPinnedTLSConfigCapturesAndMatchesServerPin(t *testing.T) {
	cert := testCertificate(t)
	expectedPin, err := serverPublicKeyPin(cert)
	if err != nil {
		t.Fatalf("compute server pin: %v", err)
	}

	captured := ""
	tlsConfig, err := buildPinnedTLSConfig("https://relay.example.com", "", &captured)
	if err != nil {
		t.Fatalf("build capture TLS config: %v", err)
	}
	if err := tlsConfig.VerifyConnection(tls.ConnectionState{
		ServerName:       "relay.example.com",
		PeerCertificates: []*x509.Certificate{cert},
	}); err != nil {
		t.Fatalf("verify capture TLS config: %v", err)
	}
	if captured != expectedPin {
		t.Fatalf("expected captured pin %q, got %q", expectedPin, captured)
	}

	tlsConfig, err = buildPinnedTLSConfig("wss://relay.example.com/ws/relay", expectedPin, nil)
	if err != nil {
		t.Fatalf("build pinned TLS config: %v", err)
	}
	if err := tlsConfig.VerifyConnection(tls.ConnectionState{
		ServerName:       "relay.example.com",
		PeerCertificates: []*x509.Certificate{cert},
	}); err != nil {
		t.Fatalf("expected pin match to verify: %v", err)
	}
}

func TestBuildPinnedTLSConfigRejectsPinMismatch(t *testing.T) {
	cert := testCertificate(t)
	tlsConfig, err := buildPinnedTLSConfig("https://relay.example.com", "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", nil)
	if err != nil {
		t.Fatalf("build pinned TLS config: %v", err)
	}
	if err := tlsConfig.VerifyConnection(tls.ConnectionState{
		ServerName:       "relay.example.com",
		PeerCertificates: []*x509.Certificate{cert},
	}); err == nil {
		t.Fatalf("expected pin mismatch to fail verification")
	}
}

func TestBuildPinnedTLSConfigRequiresPinForSecureConnections(t *testing.T) {
	if _, err := buildPinnedTLSConfig("https://relay.example.com", "", nil); err == nil {
		t.Fatalf("expected secure relay without pin to be rejected")
	}
}

func testCertificate(t *testing.T) *x509.Certificate {
	t.Helper()

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			CommonName: "relay.example.com",
		},
		NotBefore: time.Now().Add(-time.Hour),
		NotAfter:  time.Now().Add(time.Hour),
		DNSNames:  []string{"relay.example.com"},
		KeyUsage:  x509.KeyUsageDigitalSignature,
	}

	der, err := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse certificate: %v", err)
	}
	return cert
}
