//go:build !relay_installer_runtime

package nodebundle

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/PekingSpades/Synapse/relay/internal/runtimebundle"
)

//go:embed all:assets
var embeddedAssets embed.FS

func loadManifestBytes() ([]byte, error) {
	data, err := embeddedAssets.ReadFile("assets/manifest.json")
	if err != nil {
		return nil, fmt.Errorf("read node bundle manifest: %w", err)
	}
	return data, nil
}

func runtimeExtractionSupported() bool {
	return true
}

func extractRuntimeAssets(stageDir string) error {
	return fs.WalkDir(embeddedAssets, "assets", func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == "assets" {
			return nil
		}

		relativePath := strings.TrimPrefix(path, "assets/")
		targetPath := filepath.Join(stageDir, filepath.FromSlash(relativePath))
		if d.IsDir() {
			return os.MkdirAll(targetPath, 0o755)
		}

		data, err := embeddedAssets.ReadFile(path)
		if err != nil {
			return err
		}
		return runtimebundle.WriteFile(targetPath, data, 0o644)
	})
}
