//go:build desktop_cua

package vfs

func cuaRuntimeSupported() bool {
	return true
}

func CUARuntimeSupported() bool {
	return cuaRuntimeSupported()
}
