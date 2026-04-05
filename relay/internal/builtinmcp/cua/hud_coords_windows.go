//go:build windows

package cua

func displayLocalToScreenPoint(display DisplayInfo, x, y int) (int, int) {
	return display.Origin.X + x, display.Origin.Y + y
}
