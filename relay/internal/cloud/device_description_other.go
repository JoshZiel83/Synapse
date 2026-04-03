//go:build !linux && !windows && !darwin

package cloud

func platformSystemDescription() string {
	return ""
}
