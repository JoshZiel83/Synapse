package cloud

import "testing"

func TestVersionIsNewer(t *testing.T) {
	t.Parallel()

	if !versionIsNewer("1.2.3", "1.2.4") {
		t.Fatalf("expected 1.2.4 to be newer than 1.2.3")
	}
	if versionIsNewer("1.2.4", "1.2.4") {
		t.Fatalf("expected equal versions to be treated as not newer")
	}
	if versionIsNewer("dev-local", "1.2.4") {
		t.Fatalf("expected non-semver current version to disable auto-update")
	}
	if !versionIsNewer("dev-7fa7e6b4", "dev-44780dd1") {
		t.Fatalf("expected different dev commit hashes to be treated as an update")
	}
	if versionIsNewer("dev-7fa7e6b4", "dev-7fa7e6b4b22684d57270b4541746a28c6a902371") {
		t.Fatalf("expected matching dev commit prefixes to be treated as the same build")
	}
}

func TestValidateManifestDownloadURL(t *testing.T) {
	t.Parallel()

	if err := validateManifestDownloadURL("https://relay.example.com", "https://relay.example.com/downloads/relay.exe"); err != nil {
		t.Fatalf("expected same-origin download URL to pass validation: %v", err)
	}
	if err := validateManifestDownloadURL("https://relay.example.com", "https://downloads.example.net/relay.exe"); err != nil {
		t.Fatalf("expected cross-origin https download URL to pass validation: %v", err)
	}
	if err := validateManifestDownloadURL("https://relay.example.com", "http://downloads.example.net/relay.exe"); err == nil {
		t.Fatalf("expected cross-origin http download URL to be rejected")
	}
}

func TestShouldPinUpdateDownload(t *testing.T) {
	t.Parallel()

	if !shouldPinUpdateDownload("https://relay.example.com", "https://relay.example.com/downloads/relay.exe") {
		t.Fatalf("expected same-origin downloads to reuse relay server pinning")
	}
	if shouldPinUpdateDownload("https://relay.example.com", "https://downloads.example.net/relay.exe") {
		t.Fatalf("expected cross-origin downloads to skip relay server pinning")
	}
}
