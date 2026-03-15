package cua

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"strings"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"
)

func (s *Server) resolveDisplay(selector *DisplaySelector) (DisplayInfo, error) {
	displays, err := s.desktop.ListDisplays()
	if err != nil {
		return DisplayInfo{}, err
	}
	if len(displays) == 0 {
		return DisplayInfo{}, fmt.Errorf("no displays detected")
	}

	target := s.cfg.DisplaySelector
	if selector != nil {
		if !s.cfg.AllowDisplayOverride {
			return DisplayInfo{}, fmt.Errorf("display override is disabled for this server")
		}
		target = *selector
	}
	if target.Mode == "" {
		target.Mode = "main"
	}

	switch target.Mode {
	case "main":
		for _, display := range displays {
			if display.IsMain {
				return display, nil
			}
		}
		return displays[0], nil
	case "mouse":
		for _, display := range displays {
			if display.ContainsMouse {
				return display, nil
			}
		}
		return DisplayInfo{}, fmt.Errorf("the pointer is not currently within a detected display")
	case "index":
		for _, display := range displays {
			if display.Index == target.Index {
				return display, nil
			}
		}
		return DisplayInfo{}, fmt.Errorf("display index %d was not found", target.Index)
	case "id":
		for _, display := range displays {
			if display.ID == target.ID {
				return display, nil
			}
		}
		return DisplayInfo{}, fmt.Errorf("display id %d was not found", target.ID)
	case "electron_id":
		for _, display := range displays {
			if display.ElectronID == target.ElectronID {
				return display, nil
			}
		}
		return DisplayInfo{}, fmt.Errorf("display electron_id %d was not found", target.ElectronID)
	default:
		return DisplayInfo{}, fmt.Errorf("unsupported display selector mode %q", target.Mode)
	}
}

func (s *Server) convertCoordinate(display DisplayInfo, input Coordinate) (int, int, error) {
	space := strings.TrimSpace(input.Space)
	if space == "" {
		if s.cfg.RelativeCoordinate {
			space = "relative"
		} else {
			space = "image"
		}
	}

	switch space {
	case "display_pixels":
		return int(math.Round(input.X)), int(math.Round(input.Y)), nil
	case "image":
		baseWidth, baseHeight := input.BaseWidth, input.BaseHeight
		if baseWidth <= 0 || baseHeight <= 0 {
			baseWidth = s.cfg.ImageSize[0]
			baseHeight = s.cfg.ImageSize[1]
		}
		return scaleCoordinate(input.X, input.Y, baseWidth, baseHeight, display.Size.W, display.Size.H)
	case "relative":
		baseWidth, baseHeight := input.BaseWidth, input.BaseHeight
		if baseWidth <= 0 || baseHeight <= 0 {
			baseWidth = s.cfg.RelativeSize[0]
			baseHeight = s.cfg.RelativeSize[1]
		}
		return scaleCoordinate(input.X, input.Y, baseWidth, baseHeight, display.Size.W, display.Size.H)
	default:
		return 0, 0, fmt.Errorf("unsupported coordinate space %q", space)
	}
}

func scaleCoordinate(x, y float64, baseWidth, baseHeight, displayWidth, displayHeight int) (int, int, error) {
	if baseWidth <= 0 || baseHeight <= 0 {
		return 0, 0, fmt.Errorf("coordinate base dimensions must be positive")
	}
	if displayWidth <= 0 || displayHeight <= 0 {
		return 0, 0, fmt.Errorf("display dimensions must be positive")
	}

	scaledX := x * float64(displayWidth) / float64(baseWidth)
	scaledY := y * float64(displayHeight) / float64(baseHeight)
	return int(math.Round(scaledX)), int(math.Round(scaledY)), nil
}

func encodePNGBase64(img image.Image, width, height int) (string, error) {
	if width > 0 && height > 0 {
		img = resizeImage(img, width, height)
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

func resizeImage(img image.Image, width, height int) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, img.Bounds(), xdraw.Over, nil)
	return dst
}

func renderOverview(captures map[int]*image.RGBA, displays []DisplayInfo, width, height int) (*image.RGBA, error) {
	if len(displays) == 0 {
		return nil, fmt.Errorf("no displays detected")
	}

	minX, minY := displays[0].Origin.X, displays[0].Origin.Y
	maxX := displays[0].Origin.X + displays[0].Origin.W
	maxY := displays[0].Origin.Y + displays[0].Origin.H
	for _, display := range displays[1:] {
		if display.Origin.X < minX {
			minX = display.Origin.X
		}
		if display.Origin.Y < minY {
			minY = display.Origin.Y
		}
		if display.Origin.X+display.Origin.W > maxX {
			maxX = display.Origin.X + display.Origin.W
		}
		if display.Origin.Y+display.Origin.H > maxY {
			maxY = display.Origin.Y + display.Origin.H
		}
	}

	axisMargin := 48
	canvasWidth := maxX - minX + axisMargin
	canvasHeight := maxY - minY + axisMargin
	canvas := image.NewRGBA(image.Rect(0, 0, canvasWidth, canvasHeight))
	fillRect(canvas, canvas.Bounds(), color.RGBA{R: 20, G: 23, B: 28, A: 255})

	for _, display := range displays {
		capture := captures[display.Index]
		if capture == nil {
			continue
		}
		posX := display.Origin.X - minX + axisMargin
		posY := display.Origin.Y - minY + axisMargin
		destRect := image.Rect(posX, posY, posX+display.Origin.W, posY+display.Origin.H)
		xdraw.CatmullRom.Scale(canvas, destRect, capture, capture.Bounds(), xdraw.Over, nil)
		drawLabelBox(canvas, posX+8, posY+18, fmt.Sprintf("Display %d", display.Index))
		drawLabelBox(canvas, posX+8, posY+38, fmt.Sprintf("%dx%d @ (%d,%d)", display.Size.W, display.Size.H, display.Origin.X, display.Origin.Y))
		if display.IsMain {
			drawLabelBox(canvas, posX+8, posY+58, "main")
		}
	}

	if width > 0 && height > 0 {
		canvas = resizeImage(canvas, width, height)
	}
	return canvas, nil
}

func fillRect(dst *image.RGBA, rect image.Rectangle, fill color.Color) {
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			dst.Set(x, y, fill)
		}
	}
}

func drawLabelBox(dst *image.RGBA, x, y int, text string) {
	face := basicfont.Face7x13
	textWidth := font.MeasureString(face, text).Ceil()
	box := image.Rect(x-4, y-12, x+textWidth+4, y+4)
	fillRect(dst, box, color.RGBA{R: 0, G: 0, B: 0, A: 180})

	drawer := &font.Drawer{
		Dst:  dst,
		Src:  image.NewUniform(color.RGBA{R: 255, G: 255, B: 255, A: 255}),
		Face: face,
		Dot:  fixed.Point26_6{X: fixed.I(x), Y: fixed.I(y)},
	}
	drawer.DrawString(text)
}

func boolPointer(value bool) *bool {
	return &value
}

func toggleState(status string, supported bool, value *bool) KeyboardToggleState {
	return KeyboardToggleState{
		Status:    status,
		Supported: supported,
		Value:     value,
	}
}
