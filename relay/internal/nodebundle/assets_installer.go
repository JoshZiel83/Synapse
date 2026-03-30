//go:build relay_installer_runtime

package nodebundle

import (
	"fmt"

	"github.com/PekingSpades/Synapse/relay/internal/runtimebundle"
)

func loadManifestBytes() ([]byte, error) {
	data, err := runtimebundle.ReadInstalledManifest("node")
	if err != nil {
		return nil, fmt.Errorf("read installed node bundle manifest: %w", err)
	}
	return data, nil
}

func runtimeExtractionSupported() bool {
	return false
}

func extractRuntimeAssets(string) error {
	return fmt.Errorf("embedded shared node runtime assets are not included in installer builds")
}
