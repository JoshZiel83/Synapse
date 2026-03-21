package filesystem

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/extrame/xls"
	"github.com/ledongthuc/pdf"
	"github.com/richardlehane/mscfb"
	"github.com/xuri/excelize/v2"
	"golang.org/x/net/html"
)

const contentExtractorVersion = "v3"

func (s *Server) extractTextContent(path string, info os.FileInfo) (string, string, error) {
	if info.IsDir() {
		return "", "", fmt.Errorf("directories do not have text content")
	}

	ext := strings.ToLower(filepath.Ext(filepath.Base(path)))
	switch ext {
	case ".pdf":
		if s.cfg.Index.ParsePDF {
			return s.extractPDFContent(path)
		}
	case ".xlsx", ".xlsm", ".xltx", ".xltm":
		if s.cfg.Index.ParseOffice {
			return extractSpreadsheetText(path)
		}
	case ".xls", ".xlt", ".xla":
		if s.cfg.Index.ParseOffice {
			return extractLegacySpreadsheetText(path)
		}
	case ".docx", ".docm", ".dotx", ".dotm":
		if s.cfg.Index.ParseOffice {
			return s.extractArchiveDocumentText(path, []string{
				"word/document.xml",
				"word/header",
				"word/footer",
				"word/footnotes.xml",
				"word/endnotes.xml",
				"word/comments",
			}, []string{"word/media/"}, "office_xml")
		}
	case ".pptx", ".pptm", ".ppsx", ".ppsm", ".potx", ".potm":
		if s.cfg.Index.ParseOffice {
			return s.extractArchiveDocumentText(path, []string{
				"ppt/slides/",
				"ppt/notesSlides/",
				"ppt/comments/",
				"docProps/core.xml",
				"docProps/app.xml",
			}, []string{"ppt/media/"}, "office_xml")
		}
	case ".odt", ".ods", ".odp", ".odg":
		if s.cfg.Index.ParseOffice {
			return s.extractArchiveDocumentText(path, []string{
				"content.xml",
				"styles.xml",
				"meta.xml",
			}, []string{"Pictures/"}, "odf")
		}
	case ".fodt", ".fods", ".fodp":
		if s.cfg.Index.ParseOffice {
			return extractXMLFileText(path, "flat_odf")
		}
	case ".doc", ".ppt", ".pps", ".pot":
		if s.cfg.Index.ParseOffice {
			return extractLegacyOfficeText(path, ext)
		}
	case ".html", ".htm", ".xhtml":
		return extractHTMLText(path)
	case ".svg":
		return extractXMLFileText(path, "svg")
	case ".epub":
		return s.extractEPUBText(path)
	case ".rtf":
		return extractRTFText(path)
	case ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff":
		if s.cfg.Index.ParseImages {
			return s.extractImageOCRText(path)
		}
	}

	return extractPlainText(path)
}

func (s *Server) contentExtractorKey(path string, info os.FileInfo) string {
	if info.IsDir() {
		return ""
	}

	ext := strings.ToLower(filepath.Ext(filepath.Base(path)))
	switch ext {
	case ".pdf":
		if !s.cfg.Index.ParsePDF {
			return ""
		}
		key := []string{"pdf", contentExtractorVersion}
		if s.cfg.Index.ParseImages {
			key = append(key, "ocr="+binarySignature(findPDFToPPMBinary()))
			key = append(key, "tesseract="+binarySignature(findTesseractBinary()))
		}
		return strings.Join(key, "|")
	case ".xlsx", ".xlsm", ".xltx", ".xltm":
		if s.cfg.Index.ParseOffice {
			return "spreadsheet|" + contentExtractorVersion
		}
	case ".xls", ".xlt", ".xla":
		if s.cfg.Index.ParseOffice {
			return "spreadsheet_legacy|" + contentExtractorVersion + "|soffice=" + binarySignature(findLibreOfficeBinary())
		}
	case ".docx", ".docm", ".dotx", ".dotm":
		if s.cfg.Index.ParseOffice {
			return "office_xml_doc|" + contentExtractorVersion + "|tesseract=" + binarySignature(findTesseractBinaryIfEnabled(s.cfg.Index.ParseImages))
		}
	case ".pptx", ".pptm", ".ppsx", ".ppsm", ".potx", ".potm":
		if s.cfg.Index.ParseOffice {
			return "office_xml_ppt|" + contentExtractorVersion + "|tesseract=" + binarySignature(findTesseractBinaryIfEnabled(s.cfg.Index.ParseImages))
		}
	case ".odt", ".ods", ".odp", ".odg":
		if s.cfg.Index.ParseOffice {
			return "odf_package|" + contentExtractorVersion + "|tesseract=" + binarySignature(findTesseractBinaryIfEnabled(s.cfg.Index.ParseImages))
		}
	case ".fodt", ".fods", ".fodp":
		if s.cfg.Index.ParseOffice {
			return "odf_flat|" + contentExtractorVersion
		}
	case ".doc", ".ppt", ".pps", ".pot":
		if s.cfg.Index.ParseOffice {
			return "office_legacy|" + contentExtractorVersion + "|soffice=" + binarySignature(findLibreOfficeBinary())
		}
	case ".html", ".htm", ".xhtml":
		return "html|" + contentExtractorVersion
	case ".svg":
		return "svg|" + contentExtractorVersion
	case ".epub":
		return "epub|" + contentExtractorVersion + "|tesseract=" + binarySignature(findTesseractBinaryIfEnabled(s.cfg.Index.ParseImages))
	case ".rtf":
		return "rtf|" + contentExtractorVersion
	case ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff":
		if s.cfg.Index.ParseImages {
			return "image_ocr|" + contentExtractorVersion + "|tesseract=" + binarySignature(findTesseractBinary())
		}
	}

	return plainTextParser(path) + "|" + contentExtractorVersion
}

func (s *Server) extractPDFContent(path string) (string, string, error) {
	text, _, err := extractPDFText(path)
	if err != nil {
		return "", "", err
	}
	if text != "" || !s.cfg.Index.ParseImages {
		return text, "pdf", nil
	}

	ocrText, err := s.extractPDFOCRText(path)
	if err != nil {
		return "", "", err
	}
	if ocrText == "" {
		return "", "pdf", nil
	}
	return ocrText, "pdf_ocr", nil
}

func extractSpreadsheetText(path string) (string, string, error) {
	workbook, err := excelize.OpenFile(path)
	if err != nil {
		return "", "", err
	}
	defer workbook.Close()

	var builder strings.Builder
	for _, sheet := range workbook.GetSheetList() {
		builder.WriteString("# Sheet: ")
		builder.WriteString(sheet)
		builder.WriteString("\n")

		rows, err := workbook.GetRows(sheet)
		if err != nil {
			return "", "", err
		}
		for _, row := range rows {
			builder.WriteString(strings.Join(row, "\t"))
			builder.WriteString("\n")
		}
		builder.WriteString("\n")
	}
	return normalizeText(builder.String()), "spreadsheet", nil
}

func extractLegacySpreadsheetText(path string) (string, string, error) {
	workbook, err := xls.Open(path, "utf-8")
	if err != nil {
		text, parser, fallbackErr := extractLegacyOfficeText(path, ".xls")
		if fallbackErr == nil {
			return text, parser, nil
		}
		return "", "", err
	}

	var builder strings.Builder
	for index := 0; index < workbook.NumSheets(); index++ {
		sheet := workbook.GetSheet(index)
		if sheet == nil {
			continue
		}
		builder.WriteString("# Sheet: ")
		builder.WriteString(sheet.Name)
		builder.WriteString("\n")

		for rowIndex := 0; rowIndex <= int(sheet.MaxRow); rowIndex++ {
			row := sheet.Row(rowIndex)
			if row == nil {
				continue
			}
			values := make([]string, 0, maxInt(row.LastCol(), row.FirstCol()+1))
			for column := row.FirstCol(); column < maxInt(row.LastCol(), row.FirstCol()+1); column++ {
				values = append(values, strings.TrimSpace(row.Col(column)))
			}
			values = trimTrailingEmpty(values)
			if len(values) == 0 {
				continue
			}
			builder.WriteString(strings.Join(values, "\t"))
			builder.WriteString("\n")
		}
		builder.WriteString("\n")
	}

	text := normalizeText(builder.String())
	if text != "" {
		return text, "xls", nil
	}

	return extractLegacyOfficeText(path, ".xls")
}

func (s *Server) extractArchiveDocumentText(path string, textMembers []string, mediaMembers []string, parser string) (string, string, error) {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return "", "", err
	}
	defer reader.Close()

	var sections []string
	files := append([]*zip.File(nil), reader.File...)
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	for _, file := range files {
		if matchesArchiveMember(file.Name, textMembers) {
			text, err := extractArchiveTextMember(file)
			if err != nil {
				return "", "", err
			}
			if strings.TrimSpace(text) != "" {
				sections = append(sections, text)
			}
			continue
		}
		if s.cfg.Index.ParseImages && matchesArchiveDirectoryPrefix(file.Name, mediaMembers) && isImageExtension(filepath.Ext(file.Name)) {
			text, err := s.extractArchiveImageText(file)
			if err != nil {
				return "", "", err
			}
			if strings.TrimSpace(text) != "" {
				sections = append(sections, text)
			}
		}
	}
	return joinExtractedSections(sections...), parser, nil
}

func extractPDFText(path string) (string, string, error) {
	file, reader, err := pdf.Open(path)
	if err != nil {
		return "", "", err
	}
	defer file.Close()

	var builder strings.Builder
	total := reader.NumPage()
	for pageIndex := 1; pageIndex <= total; pageIndex++ {
		page := reader.Page(pageIndex)
		if page.V.IsNull() {
			continue
		}
		text, err := page.GetPlainText(nil)
		if err != nil {
			return "", "", err
		}
		builder.WriteString(text)
		builder.WriteString("\n")
	}
	return normalizeText(builder.String()), "pdf", nil
}

func extractArchiveTextMember(file *zip.File) (string, error) {
	handle, err := file.Open()
	if err != nil {
		return "", err
	}
	defer handle.Close()

	switch strings.ToLower(filepath.Ext(file.Name)) {
	case ".html", ".htm", ".xhtml":
		return extractHTMLTextFromReader(handle)
	default:
		return extractXMLText(handle)
	}
}

func extractXMLFileText(path, parser string) (string, string, error) {
	handle, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer handle.Close()

	text, err := extractXMLText(handle)
	if err != nil {
		return "", "", err
	}
	return text, parser, nil
}

func (s *Server) extractEPUBText(path string) (string, string, error) {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return "", "", err
	}
	defer reader.Close()

	var sections []string
	files := append([]*zip.File(nil), reader.File...)
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	for _, file := range files {
		ext := strings.ToLower(filepath.Ext(file.Name))
		switch ext {
		case ".xhtml", ".html", ".htm", ".opf", ".ncx":
			text, err := extractArchiveTextMember(file)
			if err != nil {
				return "", "", err
			}
			if strings.TrimSpace(text) != "" {
				sections = append(sections, text)
			}
		default:
			if s.cfg.Index.ParseImages && isImageExtension(ext) {
				text, err := s.extractArchiveImageText(file)
				if err != nil {
					return "", "", err
				}
				if strings.TrimSpace(text) != "" {
					sections = append(sections, text)
				}
			}
		}
	}
	return joinExtractedSections(sections...), "epub", nil
}

func extractRTFText(path string) (string, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}

	var builder strings.Builder
	ignorable := false
	groupStack := []bool{false}
	skipFallback := 0

	for index := 0; index < len(data); index++ {
		ch := data[index]
		switch ch {
		case '{':
			groupStack = append(groupStack, ignorable)
		case '}':
			if len(groupStack) > 1 {
				groupStack = groupStack[:len(groupStack)-1]
				ignorable = groupStack[len(groupStack)-1]
			}
		case '\\':
			if index+1 >= len(data) {
				continue
			}
			next := data[index+1]
			switch next {
			case '\\', '{', '}':
				if !ignorable {
					builder.WriteByte(next)
				}
				index++
			case '~':
				if !ignorable {
					builder.WriteByte(' ')
				}
				index++
			case '-', '_':
				if !ignorable {
					builder.WriteByte('-')
				}
				index++
			case '*':
				ignorable = true
				groupStack[len(groupStack)-1] = true
				index++
			case '\'':
				if index+3 >= len(data) {
					index = len(data)
					break
				}
				decoded, parseErr := strconv.ParseUint(string(data[index+2:index+4]), 16, 8)
				if parseErr == nil && !ignorable {
					builder.WriteByte(byte(decoded))
				}
				index += 3
			default:
				if !isRTFAlpha(next) {
					continue
				}
				wordStart := index + 1
				wordEnd := wordStart
				for wordEnd < len(data) && isRTFAlpha(data[wordEnd]) {
					wordEnd++
				}
				word := string(data[wordStart:wordEnd])

				valueEnd := wordEnd
				if valueEnd < len(data) && (data[valueEnd] == '-' || (data[valueEnd] >= '0' && data[valueEnd] <= '9')) {
					valueEnd++
					for valueEnd < len(data) && data[valueEnd] >= '0' && data[valueEnd] <= '9' {
						valueEnd++
					}
				}

				arg := strings.TrimSpace(string(data[wordEnd:valueEnd]))
				if !ignorable {
					switch word {
					case "par", "line":
						builder.WriteString("\n")
					case "tab":
						builder.WriteString("\t")
					case "emdash", "endash":
						builder.WriteString("-")
					case "u":
						value, parseErr := strconv.Atoi(arg)
						if parseErr == nil {
							builder.WriteRune(rune(value))
							skipFallback = 1
						}
					}
				}

				index = valueEnd - 1
				if index+1 < len(data) && data[index+1] == ' ' {
					index++
				}
			}
		case '\r', '\n':
		default:
			if skipFallback > 0 {
				skipFallback--
				continue
			}
			if !ignorable {
				builder.WriteByte(ch)
			}
		}
	}

	text := normalizeText(string(bytes.ToValidUTF8([]byte(builder.String()), []byte(" "))))
	return text, "rtf", nil
}

func isRTFAlpha(ch byte) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

func (s *Server) extractArchiveImageText(file *zip.File) (string, error) {
	handle, err := file.Open()
	if err != nil {
		return "", err
	}
	defer handle.Close()

	data, err := io.ReadAll(handle)
	if err != nil {
		return "", err
	}
	if len(data) == 0 {
		return "", nil
	}

	tempDir, err := os.MkdirTemp("", "synapse-archive-image-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tempDir)

	imagePath := filepath.Join(tempDir, "embedded"+strings.ToLower(filepath.Ext(file.Name)))
	if err := os.WriteFile(imagePath, data, 0o600); err != nil {
		return "", err
	}
	text, _, err := s.extractImageOCRText(imagePath)
	return text, err
}

func (s *Server) extractImageOCRText(path string) (string, string, error) {
	binaryPath, err := findTesseractBinary()
	if err != nil {
		return "", "", err
	}

	tempDir, err := os.MkdirTemp("", "synapse-image-ocr-*")
	if err != nil {
		return "", "", err
	}
	defer os.RemoveAll(tempDir)

	outputBase := filepath.Join(tempDir, "ocr-output")
	args := []string{path, outputBase}
	if lang := strings.TrimSpace(os.Getenv("SYNAPSE_RELAY_TESSERACT_LANG")); lang != "" {
		args = append(args, "-l", lang)
	}
	args = append(args, "txt")

	ctx, cancel := contextWithTimeout(60 * time.Second)
	cmd := exec.CommandContext(ctx, binaryPath, args...)
	output, runErr := cmd.CombinedOutput()
	cancel()
	if runErr != nil {
		return "", "", fmt.Errorf("tesseract OCR failed: %w %s", runErr, strings.TrimSpace(string(output)))
	}

	data, err := os.ReadFile(outputBase + ".txt")
	if err != nil {
		return "", "", err
	}
	text := normalizeText(string(bytes.ToValidUTF8(data, []byte(" "))))
	return text, "image_ocr", nil
}

func (s *Server) extractPDFOCRText(path string) (string, error) {
	if _, err := findTesseractBinary(); err != nil {
		return "", err
	}
	binaryPath, err := findPDFToPPMBinary()
	if err != nil {
		return "", err
	}

	tempDir, err := os.MkdirTemp("", "synapse-pdf-ocr-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tempDir)

	outputPrefix := filepath.Join(tempDir, "page")
	ctx, cancel := contextWithTimeout(120 * time.Second)
	cmd := exec.CommandContext(ctx, binaryPath, "-png", path, outputPrefix)
	output, runErr := cmd.CombinedOutput()
	cancel()
	if runErr != nil {
		return "", fmt.Errorf("pdftoppm failed: %w %s", runErr, strings.TrimSpace(string(output)))
	}

	images, err := filepath.Glob(outputPrefix + "-*.png")
	if err != nil {
		return "", err
	}
	sort.Strings(images)

	var sections []string
	for _, imagePath := range images {
		text, _, err := s.extractImageOCRText(imagePath)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(text) != "" {
			sections = append(sections, text)
		}
	}
	return joinExtractedSections(sections...), nil
}

func joinExtractedSections(sections ...string) string {
	filtered := make([]string, 0, len(sections))
	for _, section := range sections {
		section = strings.TrimSpace(normalizeText(section))
		if section == "" {
			continue
		}
		filtered = append(filtered, section)
	}
	return strings.TrimSpace(strings.Join(filtered, "\n\n"))
}

func isImageExtension(ext string) bool {
	switch strings.ToLower(ext) {
	case ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff":
		return true
	default:
		return false
	}
}

func extractLegacyOfficeText(path, ext string) (string, string, error) {
	libreOfficeText, parser, err := extractLegacyOfficeViaLibreOffice(path)
	if err == nil && strings.TrimSpace(libreOfficeText) != "" {
		return libreOfficeText, parser, nil
	}

	oleText, oleParser, oleErr := extractLegacyOfficeOLEText(path, ext)
	if oleErr == nil && strings.TrimSpace(oleText) != "" {
		return oleText, oleParser, nil
	}

	if err != nil && oleErr != nil {
		return "", "", fmt.Errorf("legacy office extraction failed: %w; fallback: %v", err, oleErr)
	}
	if err != nil {
		return "", "", err
	}
	return "", "", oleErr
}

func extractLegacyOfficeViaLibreOffice(path string) (string, string, error) {
	binaryPath, err := findLibreOfficeBinary()
	if err != nil {
		return "", "", err
	}

	tempDir, err := os.MkdirTemp("", "synapse-office-*")
	if err != nil {
		return "", "", err
	}
	defer os.RemoveAll(tempDir)

	baseName := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	attempts := []struct {
		spec      string
		extension string
	}{
		{spec: "txt:Text", extension: ".txt"},
		{spec: "pdf", extension: ".pdf"},
	}

	var failures []string
	for _, attempt := range attempts {
		ctx, cancel := contextWithTimeout(45 * time.Second)
		cmd := exec.CommandContext(ctx, binaryPath,
			"--headless",
			"--nologo",
			"--nolockcheck",
			"--norestore",
			"--convert-to", attempt.spec,
			"--outdir", tempDir,
			path,
		)
		output, runErr := cmd.CombinedOutput()
		cancel()

		convertedPath, locateErr := locateConvertedArtifact(tempDir, baseName, attempt.extension)
		if runErr != nil {
			failures = append(failures, strings.TrimSpace(fmt.Sprintf("%s: %v %s", attempt.spec, runErr, output)))
			continue
		}
		if locateErr != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", attempt.spec, locateErr))
			continue
		}

		switch attempt.extension {
		case ".txt":
			data, err := os.ReadFile(convertedPath)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s: %v", attempt.spec, err))
				continue
			}
			text := normalizeText(string(bytes.ToValidUTF8(data, []byte(" "))))
			if text != "" {
				return text, "office_legacy_libreoffice", nil
			}
		case ".pdf":
			text, _, err := extractPDFText(convertedPath)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s: %v", attempt.spec, err))
				continue
			}
			if text != "" {
				return text, "office_legacy_libreoffice", nil
			}
		}
	}

	if len(failures) == 0 {
		return "", "", fmt.Errorf("libreoffice produced no readable output")
	}
	return "", "", errors.New(strings.Join(failures, "; "))
}

func findLibreOfficeBinary() (string, error) {
	binaryPath, err := findExternalBinary("SYNAPSE_RELAY_SOFFICE", "soffice", "libreoffice")
	if err != nil {
		return "", fmt.Errorf("LibreOffice was not found in PATH; set SYNAPSE_RELAY_SOFFICE to enable legacy .doc/.xls/.ppt conversion")
	}
	return binaryPath, nil
}

func findTesseractBinary() (string, error) {
	binaryPath, err := findExternalBinary("SYNAPSE_RELAY_TESSERACT", "tesseract")
	if err != nil {
		return "", fmt.Errorf("Tesseract was not found in PATH; set SYNAPSE_RELAY_TESSERACT to enable image OCR")
	}
	return binaryPath, nil
}

func findTesseractBinaryIfEnabled(enabled bool) (string, error) {
	if !enabled {
		return "", nil
	}
	return findTesseractBinary()
}

func findPDFToPPMBinary() (string, error) {
	binaryPath, err := findExternalBinary("SYNAPSE_RELAY_PDFTOPPM", "pdftoppm")
	if err != nil {
		return "", fmt.Errorf("pdftoppm was not found in PATH; set SYNAPSE_RELAY_PDFTOPPM to enable scanned PDF OCR")
	}
	return binaryPath, nil
}

func binarySignature(path string, err error) string {
	if err != nil {
		return "unavailable"
	}
	if strings.TrimSpace(path) == "" {
		return "disabled"
	}
	return filepath.Clean(path)
}

func findExternalBinary(envVar string, candidates ...string) (string, error) {
	if override := strings.TrimSpace(os.Getenv(envVar)); override != "" {
		if filepath.IsAbs(override) {
			if _, err := os.Stat(override); err == nil {
				return override, nil
			}
		} else if resolved, err := exec.LookPath(override); err == nil {
			return resolved, nil
		}
	}

	for _, candidate := range candidates {
		if strings.TrimSpace(candidate) == "" {
			continue
		}
		resolved, err := exec.LookPath(candidate)
		if err == nil {
			return resolved, nil
		}
	}
	return "", fmt.Errorf("binary not found")
}

func locateConvertedArtifact(dir, baseName, extension string) (string, error) {
	matches, err := filepath.Glob(filepath.Join(dir, baseName+".*"))
	if err != nil {
		return "", err
	}
	for _, match := range matches {
		if strings.EqualFold(filepath.Ext(match), extension) {
			return match, nil
		}
	}
	return "", fmt.Errorf("no converted %s output found", extension)
}

func extractLegacyOfficeOLEText(path, ext string) (string, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer file.Close()

	reader, err := mscfb.New(file)
	if err != nil {
		return "", "", err
	}

	ordered := orderedOLEStreams(reader.File, ext)
	var fragments []string
	seen := make(map[string]struct{})

	for _, stream := range ordered {
		if stream == nil || stream.FileInfo().IsDir() {
			continue
		}
		data, err := io.ReadAll(stream)
		if err != nil {
			continue
		}
		text := joinUniqueTextFragments(extractASCIISequences(data), extractUTF16LESequences(data))
		if !looksUsefulExtractedText(text) {
			continue
		}
		if _, exists := seen[text]; exists {
			continue
		}
		seen[text] = struct{}{}
		fragments = append(fragments, text)
	}

	text := normalizeText(strings.Join(fragments, "\n"))
	if text == "" {
		return "", "", fmt.Errorf("no readable OLE text found")
	}
	return text, "office_legacy_ole", nil
}

func orderedOLEStreams(streams []*mscfb.File, ext string) []*mscfb.File {
	if len(streams) == 0 {
		return nil
	}

	preferredNames := map[string]int{}
	switch strings.ToLower(ext) {
	case ".doc":
		preferredNames["worddocument"] = 0
		preferredNames["1table"] = 1
		preferredNames["0table"] = 2
		preferredNames["data"] = 3
	case ".ppt":
		preferredNames["powerpoint document"] = 0
		preferredNames["current user"] = 1
	case ".xls":
		preferredNames["workbook"] = 0
		preferredNames["book"] = 1
	}

	type rankedStream struct {
		file  *mscfb.File
		rank  int
		index int
	}

	ranked := make([]rankedStream, 0, len(streams))
	for index, stream := range streams {
		rank := len(preferredNames) + index + 1
		if preferred, ok := preferredNames[strings.ToLower(stream.Name)]; ok {
			rank = preferred
		}
		ranked = append(ranked, rankedStream{file: stream, rank: rank, index: index})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].rank != ranked[j].rank {
			return ranked[i].rank < ranked[j].rank
		}
		return ranked[i].index < ranked[j].index
	})

	ordered := make([]*mscfb.File, 0, len(ranked))
	for _, item := range ranked {
		ordered = append(ordered, item.file)
	}
	return ordered
}

func extractASCIISequences(data []byte) []string {
	var sequences []string
	var builder strings.Builder
	flush := func() {
		text := normalizeText(builder.String())
		if looksUsefulExtractedText(text) {
			sequences = append(sequences, text)
		}
		builder.Reset()
	}

	for _, b := range data {
		if isPrintableByte(b) {
			builder.WriteByte(b)
			continue
		}
		if builder.Len() > 0 {
			flush()
		}
	}
	if builder.Len() > 0 {
		flush()
	}
	return sequences
}

func extractUTF16LESequences(data []byte) []string {
	var sequences []string
	var runes []uint16
	flush := func() {
		if len(runes) == 0 {
			return
		}
		text := normalizeText(string(utf16.Decode(runes)))
		if looksUsefulExtractedText(text) {
			sequences = append(sequences, text)
		}
		runes = nil
	}

	for index := 0; index+1 < len(data); index += 2 {
		value := binary.LittleEndian.Uint16(data[index:])
		if isPrintableUTF16(value) {
			runes = append(runes, value)
			continue
		}
		flush()
	}
	flush()
	return sequences
}

func joinUniqueTextFragments(groups ...[]string) string {
	seen := make(map[string]struct{})
	fragments := make([]string, 0)
	for _, group := range groups {
		for _, item := range group {
			item = normalizeText(item)
			if !looksUsefulExtractedText(item) {
				continue
			}
			if _, exists := seen[item]; exists {
				continue
			}
			seen[item] = struct{}{}
			fragments = append(fragments, item)
		}
	}
	return strings.Join(fragments, "\n")
}

func looksUsefulExtractedText(text string) bool {
	text = strings.TrimSpace(text)
	if len([]rune(text)) < 4 {
		return false
	}
	for _, r := range text {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			return true
		}
	}
	return false
}

func isPrintableByte(value byte) bool {
	return value == '\n' || value == '\r' || value == '\t' || (value >= 32 && value <= 126)
}

func isPrintableUTF16(value uint16) bool {
	if value == 0 {
		return false
	}
	r := rune(value)
	if r == utf8.RuneError {
		return false
	}
	if r == '\n' || r == '\r' || r == '\t' {
		return true
	}
	return !unicode.IsControl(r)
}

func extractHTMLText(path string) (string, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}
	text, err := extractHTMLTextFromReader(bytes.NewReader(data))
	if err != nil {
		return "", "", err
	}
	return text, "html", nil
}

func extractHTMLTextFromReader(reader io.Reader) (string, error) {
	doc, err := html.Parse(reader)
	if err != nil {
		return "", err
	}
	var builder strings.Builder
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.ElementNode && isIgnoredHTMLTag(node.Data) {
			return
		}
		if node.Type == html.ElementNode && isBlockHTMLTag(node.Data) {
			builder.WriteString("\n")
		}
		if node.Type == html.TextNode {
			builder.WriteString(node.Data)
			builder.WriteString(" ")
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
		if node.Type == html.ElementNode && isBlockHTMLTag(node.Data) {
			builder.WriteString("\n")
		}
	}
	walk(doc)
	return normalizeText(builder.String()), nil
}

func isIgnoredHTMLTag(tag string) bool {
	switch strings.ToLower(tag) {
	case "script", "style", "noscript", "head":
		return true
	default:
		return false
	}
}

func isBlockHTMLTag(tag string) bool {
	switch strings.ToLower(tag) {
	case "address", "article", "aside", "blockquote", "br", "div", "dl", "dt", "dd",
		"fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
		"header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody",
		"td", "th", "thead", "tr", "ul":
		return true
	default:
		return false
	}
}

func extractPlainText(path string) (string, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}
	if len(data) == 0 {
		return "", "text", nil
	}
	text, ok := decodeExtractableText(path, data)
	if !ok {
		return "", "", nil
	}
	return normalizeText(text), plainTextParser(path), nil
}

func extractXMLText(reader io.Reader) (string, error) {
	decoder := xml.NewDecoder(reader)
	var builder strings.Builder
	pendingNewline := false

	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}

		switch token := token.(type) {
		case xml.StartElement:
			switch strings.ToLower(token.Name.Local) {
			case "p", "row", "tr", "div":
				pendingNewline = true
			}
		case xml.CharData:
			text := normalizeText(string(token))
			if text == "" {
				continue
			}
			if builder.Len() > 0 {
				if pendingNewline {
					builder.WriteString("\n")
				} else {
					builder.WriteString(" ")
				}
			}
			pendingNewline = false
			builder.WriteString(text)
		case xml.EndElement:
			switch strings.ToLower(token.Name.Local) {
			case "p", "row", "tr", "div", "br":
				pendingNewline = true
			}
		}
	}

	return normalizeText(builder.String()), nil
}

func matchesArchiveMember(name string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasSuffix(prefix, "/") {
			if strings.HasPrefix(name, prefix) && strings.HasSuffix(name, ".xml") {
				return true
			}
			continue
		}
		if filepath.Ext(prefix) == "" && strings.HasPrefix(name, prefix) && strings.HasSuffix(name, ".xml") {
			return true
		}
		if name == prefix {
			return true
		}
	}
	return false
}

func matchesArchiveDirectoryPrefix(name string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasSuffix(prefix, "/") {
			if strings.HasPrefix(name, prefix) {
				return true
			}
			continue
		}
		if name == prefix {
			return true
		}
	}
	return false
}

func matchesConfiguredFileType(name, ext string, configured []string) bool {
	if len(configured) == 0 {
		return true
	}
	lowerName := strings.ToLower(name)
	for _, item := range configured {
		item = strings.TrimSpace(strings.ToLower(item))
		if item == "" {
			continue
		}
		if strings.HasPrefix(item, ".") {
			if ext == item {
				return true
			}
			continue
		}
		if lowerName == item {
			return true
		}
	}
	return false
}

func looksLikeText(path string, data []byte) bool {
	if strings.HasPrefix(mime.TypeByExtension(strings.ToLower(filepath.Ext(path))), "text/") {
		return true
	}
	if utf8.Valid(data) {
		controls := 0
		for _, b := range data {
			if b == 0 {
				return false
			}
			if b < 32 && b != '\n' && b != '\r' && b != '\t' {
				controls++
			}
		}
		return controls*20 < len(data)
	}
	return false
}

func decodeExtractableText(path string, data []byte) (string, bool) {
	if len(data) == 0 {
		return "", true
	}
	if decoded, ok := decodeUTF16Text(data); ok {
		return decoded, true
	}
	if looksLikeText(path, data) {
		return string(bytes.ToValidUTF8(data, []byte(" "))), true
	}
	return "", false
}

func decodeUTF16Text(data []byte) (string, bool) {
	if len(data) < 2 || len(data)%2 != 0 {
		return "", false
	}

	var byteOrder binary.ByteOrder = binary.LittleEndian
	switch {
	case len(data) >= 2 && data[0] == 0xFF && data[1] == 0xFE:
		data = data[2:]
	case len(data) >= 2 && data[0] == 0xFE && data[1] == 0xFF:
		data = data[2:]
		byteOrder = binary.BigEndian
	default:
		zerosAtOdd := 0
		zerosAtEven := 0
		samples := 0
		for index := 0; index+1 < len(data) && samples < 64; index += 2 {
			if data[index] == 0 {
				zerosAtEven++
			}
			if data[index+1] == 0 {
				zerosAtOdd++
			}
			samples++
		}
		if samples == 0 {
			return "", false
		}
		if zerosAtOdd*2 >= samples {
			byteOrder = binary.LittleEndian
		} else if zerosAtEven*2 >= samples {
			byteOrder = binary.BigEndian
		} else {
			return "", false
		}
	}

	words := make([]uint16, 0, len(data)/2)
	for index := 0; index+1 < len(data); index += 2 {
		words = append(words, byteOrder.Uint16(data[index:index+2]))
	}
	return string(utf16.Decode(words)), true
}

func plainTextParser(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".html", ".htm", ".xhtml":
		return "html"
	case ".xml":
		return "xml"
	default:
		return "text"
	}
}

func normalizeText(input string) string {
	input = strings.ReplaceAll(input, "\u0000", " ")
	input = strings.ReplaceAll(input, "\r\n", "\n")
	input = strings.ReplaceAll(input, "\r", "\n")

	lines := strings.Split(input, "\n")
	normalized := make([]string, 0, len(lines))
	pendingBlank := false
	for _, line := range lines {
		line = strings.Join(strings.Fields(line), " ")
		if line == "" {
			if len(normalized) > 0 {
				pendingBlank = true
			}
			continue
		}
		if pendingBlank {
			normalized = append(normalized, "")
			pendingBlank = false
		}
		normalized = append(normalized, line)
	}

	for len(normalized) > 0 && normalized[len(normalized)-1] == "" {
		normalized = normalized[:len(normalized)-1]
	}
	return strings.TrimSpace(strings.Join(normalized, "\n"))
}

func trimTrailingEmpty(values []string) []string {
	end := len(values)
	for end > 0 && strings.TrimSpace(values[end-1]) == "" {
		end--
	}
	return values[:end]
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func contextWithTimeout(timeout time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), timeout)
}
