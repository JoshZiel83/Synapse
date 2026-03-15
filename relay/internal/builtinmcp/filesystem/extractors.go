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

func (s *Server) extractTextContent(path string, info os.FileInfo) (string, string, error) {
	if info.IsDir() {
		return "", "", fmt.Errorf("directories do not have text content")
	}

	ext := strings.ToLower(filepath.Ext(filepath.Base(path)))
	switch ext {
	case ".pdf":
		if s.cfg.Index.ParsePDF {
			return extractPDFText(path)
		}
	case ".xlsx", ".xlsm", ".xltx", ".xltm":
		if s.cfg.Index.ParseOffice {
			return extractSpreadsheetText(path)
		}
	case ".xls":
		if s.cfg.Index.ParseOffice {
			return extractLegacySpreadsheetText(path)
		}
	case ".docx":
		if s.cfg.Index.ParseOffice {
			return extractOfficeXMLText(path, []string{"word/document.xml"})
		}
	case ".pptx":
		if s.cfg.Index.ParseOffice {
			return extractOfficeXMLText(path, []string{"ppt/slides/"})
		}
	case ".odt", ".ods", ".odp":
		if s.cfg.Index.ParseOffice {
			return extractOfficeXMLText(path, []string{"content.xml"})
		}
	case ".doc", ".ppt":
		if s.cfg.Index.ParseOffice {
			return extractLegacyOfficeText(path, ext)
		}
	case ".html", ".htm", ".xhtml":
		return extractHTMLText(path)
	}

	return extractPlainText(path)
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

func extractOfficeXMLText(path string, members []string) (string, string, error) {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return "", "", err
	}
	defer reader.Close()

	var builder strings.Builder
	for _, file := range reader.File {
		if !matchesArchiveMember(file.Name, members) {
			continue
		}
		handle, err := file.Open()
		if err != nil {
			return "", "", err
		}
		text, err := extractXMLText(handle)
		handle.Close()
		if err != nil {
			return "", "", err
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		builder.WriteString(text)
		builder.WriteString("\n")
	}
	return normalizeText(builder.String()), "office_xml", nil
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
	candidates := []string{}
	if override := strings.TrimSpace(os.Getenv("SYNAPSE_RELAY_SOFFICE")); override != "" {
		candidates = append(candidates, override)
	}
	candidates = append(candidates, "soffice", "libreoffice")

	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if filepath.IsAbs(candidate) {
			if _, err := os.Stat(candidate); err == nil {
				return candidate, nil
			}
			continue
		}
		resolved, err := exec.LookPath(candidate)
		if err == nil {
			return resolved, nil
		}
	}

	return "", fmt.Errorf("LibreOffice was not found in PATH; set SYNAPSE_RELAY_SOFFICE to enable legacy .doc/.xls/.ppt conversion")
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
	doc, err := html.Parse(bytes.NewReader(data))
	if err != nil {
		return "", "", err
	}

	var builder strings.Builder
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.TextNode {
			text := normalizeText(node.Data)
			if text != "" {
				if builder.Len() > 0 {
					builder.WriteString(" ")
				}
				builder.WriteString(text)
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(doc)
	return normalizeText(builder.String()), "html", nil
}

func extractPlainText(path string) (string, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}
	if len(data) == 0 {
		return "", "text", nil
	}
	if !looksLikeText(path, data) {
		return "", "", nil
	}
	data = bytes.ToValidUTF8(data, []byte(" "))
	return normalizeText(string(data)), plainTextParser(path), nil
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
	fields := strings.Fields(strings.ReplaceAll(input, "\u0000", " "))
	return strings.TrimSpace(strings.Join(fields, " "))
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
