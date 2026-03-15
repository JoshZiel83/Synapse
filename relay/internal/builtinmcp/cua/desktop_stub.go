//go:build !desktop_cua

package cua

import "fmt"

func newDefaultDesktop() (Desktop, error) {
	return nil, fmt.Errorf("desktop CUA support is not built into this binary; rebuild with the desktop_cua build tag")
}
