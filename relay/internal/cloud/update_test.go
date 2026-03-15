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
}

func TestValidateManifestDownloadURL(t *testing.T) {
	t.Parallel()

	if err := validateManifestDownloadURL("https://synapse.example.com", "https://synapse.example.com/downloads/relay.exe"); err != nil {
		t.Fatalf("expected same-origin download URL to pass validation: %v", err)
	}
	if err := validateManifestDownloadURL("https://synapse.example.com", "https://cdn.example.com/relay.exe"); err == nil {
		t.Fatalf("expected cross-origin download URL to be rejected")
	}
}
