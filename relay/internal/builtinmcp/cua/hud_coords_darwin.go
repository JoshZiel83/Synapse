//go:build darwin

package cua

func displayLocalToScreenPoint(display DisplayInfo, x, y int) (int, int) {
	if display.Scale <= 0 {
		return display.Origin.X + x, display.Origin.Y + y
	}
	return display.Origin.X + int(float64(x)/display.Scale), display.Origin.Y + int(float64(y)/display.Scale)
}
