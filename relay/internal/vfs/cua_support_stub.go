//go:build !desktop_cua

package vfs

func cuaRuntimeSupported() bool {
	return false
}

func CUARuntimeSupported() bool {
	return cuaRuntimeSupported()
}
