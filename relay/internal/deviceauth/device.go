package deviceauth

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
)

type Identity struct {
	PrivateKeyPath string
	PublicKeyPEM   string
	Fingerprint    string
}

func EnsureIdentity(privateKeyPath string) (*Identity, error) {
	if privateKeyPath == "" {
		return nil, fmt.Errorf("private key path is required")
	}

	if _, err := os.Stat(privateKeyPath); err == nil {
		return LoadIdentity(privateKeyPath)
	}

	return GenerateIdentity(privateKeyPath)
}

func GenerateIdentity(privateKeyPath string) (*Identity, error) {
	if privateKeyPath == "" {
		return nil, fmt.Errorf("private key path is required")
	}

	if err := os.MkdirAll(filepath.Dir(privateKeyPath), 0700); err != nil {
		return nil, fmt.Errorf("create key dir: %w", err)
	}

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate device key: %w", err)
	}

	privateKeyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("marshal private key: %w", err)
	}

	privateKeyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: privateKeyDER,
	})
	if err := os.WriteFile(privateKeyPath, privateKeyPEM, 0600); err != nil {
		return nil, fmt.Errorf("write private key: %w", err)
	}

	return buildIdentity(privateKeyPath, publicKey)
}

func LoadIdentity(privateKeyPath string) (*Identity, error) {
	privateKey, publicKey, err := loadKeyPair(privateKeyPath)
	if err != nil {
		return nil, err
	}
	_ = privateKey
	return buildIdentity(privateKeyPath, publicKey)
}

func SignChallenge(privateKeyPath, deviceID, challengeID, nonce string) (string, error) {
	privateKey, _, err := loadKeyPair(privateKeyPath)
	if err != nil {
		return "", err
	}

	payload := BuildChallengePayload(deviceID, challengeID, nonce)
	signature := ed25519.Sign(privateKey, payload)
	return base64.StdEncoding.EncodeToString(signature), nil
}

func BuildChallengePayload(deviceID, challengeID, nonce string) []byte {
	return []byte(fmt.Sprintf("synapse-relay-auth:%s:%s:%s", deviceID, challengeID, nonce))
}

func buildIdentity(privateKeyPath string, publicKey ed25519.PublicKey) (*Identity, error) {
	publicKeyDER, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return nil, fmt.Errorf("marshal public key: %w", err)
	}

	publicKeyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: publicKeyDER,
	})

	fingerprintHash := sha256.Sum256(publicKeyDER)
	return &Identity{
		PrivateKeyPath: privateKeyPath,
		PublicKeyPEM:   string(publicKeyPEM),
		Fingerprint:    hex.EncodeToString(fingerprintHash[:]),
	}, nil
}

func loadKeyPair(privateKeyPath string) (ed25519.PrivateKey, ed25519.PublicKey, error) {
	data, err := os.ReadFile(privateKeyPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read private key: %w", err)
	}

	block, _ := pem.Decode(data)
	if block == nil {
		return nil, nil, fmt.Errorf("decode private key: PEM block not found")
	}

	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("parse private key: %w", err)
	}

	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, nil, fmt.Errorf("parse private key: not an ed25519 private key")
	}

	publicKey, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok {
		return nil, nil, fmt.Errorf("derive public key: not an ed25519 public key")
	}

	return privateKey, publicKey, nil
}
