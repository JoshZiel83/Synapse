//go:build !linux && !darwin && !windows

package vfs

import "github.com/PekingSpades/Synapse/relay/internal/relaypaths"

func newCUASemanticProvider(paths relaypaths.ResolvedPaths) cuaSemanticProvider {
	_ = paths
	return &scriptCUASemanticProvider{
		backend: "",
		script:  "",
	}
}
