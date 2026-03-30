//go:build relay_installer_runtime

package chromemcpbundle

import (
	"fmt"

	"github.com/PekingSpades/Synapse/relay/internal/runtimebundle"
)

func loadManifestBytes() ([]byte, error) {
	data, err := runtimebundle.ReadInstalledManifest("chrome-devtools-mcp")
	if err != nil {
		return nil, fmt.Errorf("read installed chrome-devtools bundle manifest: %w", err)
	}
	return data, nil
}

func runtimeExtractionSupported() bool {
	return false
}

func extractRuntimeAssets(string) error {
	return fmt.Errorf("embedded chrome-devtools runtime assets are not included in installer builds")
}
