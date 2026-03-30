//go:build relay_installer_runtime

package commandlinebundle

import (
	"fmt"

	"github.com/PekingSpades/Synapse/relay/internal/runtimebundle"
)

func loadManifestBytes() ([]byte, error) {
	data, err := runtimebundle.ReadInstalledManifest("commandline")
	if err != nil {
		return nil, fmt.Errorf("read installed commandline bundle manifest: %w", err)
	}
	return data, nil
}

func runtimeExtractionSupported() bool {
	return false
}

func extractRuntimeAssets(string) error {
	return fmt.Errorf("embedded commandline runtime assets are not included in installer builds")
}
