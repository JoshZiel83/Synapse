package cloud

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"net"
	"net/url"
	"strings"
)

type serverIdentityError struct {
	message string
}

func (e *serverIdentityError) Error() string {
	return e.message
}

func requiresPinnedServerIdentity(rawURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return false
	}

	switch strings.ToLower(parsed.Scheme) {
	case "https", "wss":
		return true
	default:
		return false
	}
}

func validateSecureRelayURL(rawURL string) error {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return &serverIdentityError{message: fmt.Sprintf("invalid relay URL: %v", err)}
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return &serverIdentityError{message: "relay URL must include scheme and host"}
	}

	scheme := strings.ToLower(parsed.Scheme)
	host := parsed.Hostname()
	switch scheme {
	case "https", "wss":
		return nil
	case "http", "ws":
		if isLoopbackHost(host) {
			return nil
		}
		return &serverIdentityError{message: "remote relay servers must use https/wss"}
	default:
		return &serverIdentityError{message: fmt.Sprintf("unsupported relay URL scheme %q", parsed.Scheme)}
	}
}

func buildPinnedTLSConfig(rawURL, expectedPin string, capturePin *string) (*tls.Config, error) {
	if err := validateSecureRelayURL(rawURL); err != nil {
		return nil, err
	}
	if !requiresPinnedServerIdentity(rawURL) {
		return nil, nil
	}

	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return nil, &serverIdentityError{message: fmt.Sprintf("invalid relay URL: %v", err)}
	}
	if strings.TrimSpace(expectedPin) == "" && capturePin == nil {
		return nil, &serverIdentityError{message: "missing relay server TLS public key pin; re-pair this relay device"}
	}

	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: parsed.Hostname(),
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return &serverIdentityError{message: "relay server did not present a certificate"}
			}

			actualPin, err := serverPublicKeyPin(cs.PeerCertificates[0])
			if err != nil {
				return &serverIdentityError{message: fmt.Sprintf("failed to compute relay server pin: %v", err)}
			}
			if capturePin != nil && *capturePin == "" {
				*capturePin = actualPin
			}
			if strings.TrimSpace(expectedPin) != "" && !secureStringEqual(strings.TrimSpace(expectedPin), actualPin) {
				return &serverIdentityError{message: "relay server TLS public key pin mismatch"}
			}
			return nil
		},
	}, nil
}

func serverPublicKeyPin(cert *x509.Certificate) (string, error) {
	if cert == nil || len(cert.RawSubjectPublicKeyInfo) == 0 {
		return "", fmt.Errorf("certificate public key not available")
	}
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return "sha256:" + base64.StdEncoding.EncodeToString(sum[:]), nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func secureStringEqual(left, right string) bool {
	if len(left) != len(right) {
		return false
	}

	mismatch := byte(0)
	for i := 0; i < len(left); i++ {
		mismatch |= left[i] ^ right[i]
	}
	return mismatch == 0
}
