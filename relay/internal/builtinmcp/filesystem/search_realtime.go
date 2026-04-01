package filesystem

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type grepCandidateFile struct {
	Path string
	Info os.FileInfo
}

func absolutizeRipgrepPath(baseDir, candidate string) string {
	candidate = filepath.Clean(strings.TrimSpace(candidate))
	if candidate == "" {
		return ""
	}
	if filepath.IsAbs(candidate) {
		return candidate
	}
	if strings.TrimSpace(baseDir) == "" {
		return candidate
	}
	return filepath.Clean(filepath.Join(baseDir, candidate))
}

func ripgrepSearchContext(root string, rootInfo os.FileInfo) (string, string, string) {
	if rootInfo.IsDir() {
		return root, ".", root
	}
	workingDir := filepath.Dir(root)
	return workingDir, filepath.Base(root), workingDir
}

func buildRipgrepSearchArgs(pattern, include string, exclude []string, respectGitignore, caseInsensitive, multiline bool, leadingArgs ...string) []string {
	args := ripgrepCommonArgs(exclude, respectGitignore)
	if caseInsensitive {
		args = append(args, "-i")
	}
	if multiline {
		args = append(args, "-U", "--multiline-dotall")
	}
	args = append(args, leadingArgs...)
	if strings.TrimSpace(include) != "" {
		args = append(args, "--glob", strings.TrimSpace(include))
	}
	args = append(args, "-e", pattern)
	return args
}

func collectSortedMatchedPaths(baseDir string, paths []string, pathFilter *pathSearchFilter) []matchedPath {
	seen := make(map[string]struct{}, len(paths))
	matches := make([]matchedPath, 0, len(paths))
	for _, path := range paths {
		path = absolutizeRipgrepPath(baseDir, path)
		if path == "" {
			continue
		}
		if _, exists := seen[path]; exists {
			continue
		}
		seen[path] = struct{}{}

		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		if pathFilter != nil && pathFilter.Skip(path, false) {
			continue
		}
		matches = append(matches, matchedPath{
			Path:       path,
			ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
			ModTime:    info.ModTime(),
		})
	}
	sortMatchedPaths(matches)
	return matches
}

func paginateMatchedPaths(matches []matchedPath, offset, limit int) ([]matchedPath, int, bool, int, int) {
	total := len(matches)
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	if limit <= 0 {
		limit = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	return matches[offset:end], total, end < total, offset, limit
}

func (s *Server) globMatchesWithRipgrep(ctx context.Context, root, pattern string, pathFilter *pathSearchFilter, exclude []string, respectGitignore bool) ([]matchedPath, error) {
	args := ripgrepCommonArgs(exclude, respectGitignore)
	args = append(args, "--files", "--glob", strings.TrimSpace(pattern))
	lines, err := runRipgrepLines(ctx, root, ".", args...)
	if err != nil {
		return nil, err
	}
	return collectSortedMatchedPaths(root, lines, pathFilter), nil
}

func collectSortedGrepCountEntries(baseDir string, lines []string, pathFilter *pathSearchFilter) []grepCountEntry {
	seen := make(map[string]struct{}, len(lines))
	entries := make([]grepCountEntry, 0, len(lines))
	for _, line := range lines {
		separator := strings.LastIndex(line, ":")
		if separator <= 0 || separator >= len(line)-1 {
			continue
		}
		count, err := strconv.Atoi(strings.TrimSpace(line[separator+1:]))
		if err != nil {
			continue
		}
		path := absolutizeRipgrepPath(baseDir, line[:separator])
		if path == "" {
			continue
		}
		if _, exists := seen[path]; exists {
			continue
		}
		seen[path] = struct{}{}

		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		if pathFilter != nil && pathFilter.Skip(path, false) {
			continue
		}
		entries = append(entries, grepCountEntry{
			Path:       path,
			ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
			MatchCount: count,
			ModTime:    info.ModTime().UnixNano(),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].ModTime != entries[j].ModTime {
			return entries[i].ModTime > entries[j].ModTime
		}
		return entries[i].Path < entries[j].Path
	})
	return entries
}

func sanitizeGrepCandidateFiles(baseDir string, paths []string, pathFilter *pathSearchFilter) []grepCandidateFile {
	seen := make(map[string]struct{}, len(paths))
	candidates := make([]grepCandidateFile, 0, len(paths))
	for _, path := range paths {
		path = absolutizeRipgrepPath(baseDir, path)
		if path == "" {
			continue
		}
		if _, exists := seen[path]; exists {
			continue
		}
		seen[path] = struct{}{}

		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		if pathFilter != nil && pathFilter.Skip(path, false) {
			continue
		}
		candidates = append(candidates, grepCandidateFile{
			Path: path,
			Info: info,
		})
	}
	sort.Slice(candidates, func(i, j int) bool {
		left := candidates[i]
		right := candidates[j]
		if !left.Info.ModTime().Equal(right.Info.ModTime()) {
			return left.Info.ModTime().After(right.Info.ModTime())
		}
		return left.Path < right.Path
	})
	return candidates
}

func buildGrepFileMatch(path string, info os.FileInfo, re *regexp.Regexp, contextBefore, contextAfter, maxMatches int) (grepFileMatch, bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return grepFileMatch{}, false, nil
	}
	text, ok := decodeExtractableText(path, data)
	if !ok {
		return grepFileMatch{}, false, nil
	}

	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	indexes := re.FindAllStringIndex(normalized, -1)
	if len(indexes) == 0 {
		return grepFileMatch{}, false, nil
	}

	lines, lineOffsets := splitLinesWithOffsets(normalized)
	fileMatch := grepFileMatch{
		Path:       path,
		ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
		ModTime:    info.ModTime().UnixNano(),
	}

	truncated := false
	if maxMatches < len(indexes) {
		indexes = indexes[:maxMatches]
		truncated = true
	}
	for _, location := range indexes {
		lineIndex := lineIndexForOffset(lineOffsets, location[0])
		preview, _ := truncateLine(lines[lineIndex], 400)
		matchText, _ := truncateLine(normalized[location[0]:location[1]], 400)
		occurrence := grepOccurrence{
			Line:    lineIndex + 1,
			Column:  columnForOffset(lines[lineIndex], location[0]-lineOffsets[lineIndex]),
			Match:   matchText,
			Preview: preview,
			Before:  contextWindow(lines, lineIndex-contextBefore, lineIndex),
			After:   contextWindow(lines, lineIndex+1, lineIndex+1+contextAfter),
		}
		fileMatch.Occurrences = append(fileMatch.Occurrences, occurrence)
	}
	fileMatch.MatchCount = len(fileMatch.Occurrences)
	return fileMatch, truncated, nil
}

func buildGrepMatchesFromCandidates(candidates []grepCandidateFile, re *regexp.Regexp, maxMatches, contextBefore, contextAfter int) ([]grepFileMatch, bool, error) {
	matches := make([]grepFileMatch, 0, len(candidates))
	remaining := maxMatches
	truncated := false

	for index, candidate := range candidates {
		if remaining <= 0 {
			truncated = true
			break
		}
		fileMatch, hitLimit, err := buildGrepFileMatch(candidate.Path, candidate.Info, re, contextBefore, contextAfter, remaining)
		if err != nil {
			return nil, false, err
		}
		if fileMatch.MatchCount == 0 {
			continue
		}
		matches = append(matches, fileMatch)
		remaining -= fileMatch.MatchCount
		if hitLimit {
			truncated = true
			break
		}
		if remaining == 0 && index < len(candidates)-1 {
			truncated = true
			break
		}
	}

	return matches, truncated, nil
}

func (s *Server) grepFilePathsWithRipgrep(ctx context.Context, root string, rootInfo os.FileInfo, pattern, include string, pathFilter *pathSearchFilter, exclude []string, respectGitignore, caseInsensitive, multiline bool) ([]matchedPath, error) {
	args := buildRipgrepSearchArgs(pattern, include, exclude, respectGitignore, caseInsensitive, multiline, "-l")
	workingDir, target, baseDir := ripgrepSearchContext(root, rootInfo)
	lines, err := runRipgrepLines(ctx, workingDir, target, args...)
	if err != nil {
		return nil, err
	}
	return collectSortedMatchedPaths(baseDir, lines, pathFilter), nil
}

func (s *Server) grepCountEntriesWithRipgrep(ctx context.Context, root string, rootInfo os.FileInfo, pattern, include string, pathFilter *pathSearchFilter, exclude []string, respectGitignore, caseInsensitive, multiline bool) ([]grepCountEntry, error) {
	args := buildRipgrepSearchArgs(pattern, include, exclude, respectGitignore, caseInsensitive, multiline, "--count-matches")
	workingDir, target, baseDir := ripgrepSearchContext(root, rootInfo)
	lines, err := runRipgrepLines(ctx, workingDir, target, args...)
	if err != nil {
		return nil, err
	}
	return collectSortedGrepCountEntries(baseDir, lines, pathFilter), nil
}

func (s *Server) grepMatchesDetailedWithRipgrep(ctx context.Context, root string, rootInfo os.FileInfo, re *regexp.Regexp, pattern, include string, pathFilter *pathSearchFilter, exclude []string, respectGitignore, caseInsensitive, multiline bool, maxMatches, contextBefore, contextAfter int) ([]grepFileMatch, bool, error) {
	args := buildRipgrepSearchArgs(pattern, include, exclude, respectGitignore, caseInsensitive, multiline, "-l")
	workingDir, target, baseDir := ripgrepSearchContext(root, rootInfo)

	lines, err := runRipgrepLines(ctx, workingDir, target, args...)
	if err != nil {
		return nil, false, err
	}
	candidates := sanitizeGrepCandidateFiles(baseDir, lines, pathFilter)
	return buildGrepMatchesFromCandidates(candidates, re, maxMatches, contextBefore, contextAfter)
}
