//go:build !linux && !darwin && !windows

package cua

func platformSystemDescription() string {
	return ""
}
