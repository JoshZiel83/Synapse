package filesystem

import (
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/bmatcuk/doublestar/v4"
)

var defaultNoisyPathSegments = map[string]struct{}{
	".git":         {},
	"node_modules": {},
	"dist":         {},
	".next":        {},
}

type pathSearchFilter struct {
	root             string
	exclude          []string
	respectGitignore bool

	matcherMu     sync.Mutex
	matcherCache  map[string]*gitignoreMatcher
	matcherLoaded map[string]bool
}

type gitignoreMatcher struct {
	baseDir string
	rules   []gitignoreRule
}

type gitignoreRule struct {
	pattern  string
	negated  bool
	dirOnly  bool
	hasSlash bool
}

func newPathSearchFilter(root string, exclude []string, respectGitignore bool) (*pathSearchFilter, error) {
	root = filepath.Clean(root)
	return &pathSearchFilter{
		root:             root,
		exclude:          normalizeExcludePatterns(exclude),
		respectGitignore: respectGitignore,
		matcherCache:     make(map[string]*gitignoreMatcher),
		matcherLoaded:    make(map[string]bool),
	}, nil
}

func normalizeExcludePatterns(values []string) []string {
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if filepath.IsAbs(value) {
			normalized = append(normalized, filepath.Clean(value))
			continue
		}
		normalized = append(normalized, filepath.ToSlash(value))
	}
	return normalized
}

func (f *pathSearchFilter) Skip(absPath string, isDir bool) bool {
	if f == nil {
		return false
	}
	absPath = filepath.Clean(absPath)
	rel, err := filepath.Rel(f.root, absPath)
	if err != nil {
		return false
	}
	if rel == "." {
		return false
	}
	normalizedRel := filepath.ToSlash(rel)
	if matchesDefaultNoisyPath(normalizedRel) {
		return true
	}
	if matchesExcludePattern(f.exclude, absPath, normalizedRel) {
		return true
	}
	if !f.respectGitignore {
		return false
	}

	segments := strings.Split(normalizedRel, "/")
	activeMatchers := make([]*gitignoreMatcher, 0, len(segments)+1)
	if matcher, err := f.matcherForDir(f.root); err == nil && matcher != nil {
		activeMatchers = append(activeMatchers, matcher)
	}

	currentPath := f.root
	for index, segment := range segments {
		currentPath = filepath.Join(currentPath, segment)
		currentIsDir := index < len(segments)-1 || isDir

		ignored := false
		matched := false
		for _, matcher := range activeMatchers {
			nextMatched, nextIgnored := matcher.Match(currentPath, currentIsDir)
			if nextMatched {
				matched = true
				ignored = nextIgnored
			}
		}
		if matched && ignored {
			return true
		}
		if currentIsDir {
			matcher, err := f.matcherForDir(currentPath)
			if err == nil && matcher != nil {
				activeMatchers = append(activeMatchers, matcher)
			}
		}
	}
	return false
}

func matchesDefaultNoisyPath(relPath string) bool {
	for _, segment := range strings.Split(relPath, "/") {
		if _, exists := defaultNoisyPathSegments[segment]; exists {
			return true
		}
	}
	return false
}

func matchesExcludePattern(patterns []string, absPath, relPath string) bool {
	baseName := filepath.Base(absPath)
	for _, pattern := range patterns {
		if filepath.IsAbs(pattern) {
			if pathWithinPrefix(absPath, pattern) {
				return true
			}
			continue
		}
		ok, err := doublestar.PathMatch(pattern, relPath)
		if err == nil && ok {
			return true
		}
		ok, err = doublestar.PathMatch(pattern, baseName)
		if err == nil && ok {
			return true
		}
	}
	return false
}

func (f *pathSearchFilter) matcherForDir(dir string) (*gitignoreMatcher, error) {
	dir = filepath.Clean(dir)

	f.matcherMu.Lock()
	if f.matcherLoaded[dir] {
		matcher := f.matcherCache[dir]
		f.matcherMu.Unlock()
		return matcher, nil
	}
	f.matcherMu.Unlock()

	gitignorePath := filepath.Join(dir, ".gitignore")
	info, err := os.Stat(gitignorePath)
	if err != nil {
		if os.IsNotExist(err) {
			f.matcherMu.Lock()
			f.matcherLoaded[dir] = true
			f.matcherMu.Unlock()
			return nil, nil
		}
		return nil, err
	}
	if info.IsDir() {
		f.matcherMu.Lock()
		f.matcherLoaded[dir] = true
		f.matcherMu.Unlock()
		return nil, nil
	}

	data, err := os.ReadFile(gitignorePath)
	if err != nil {
		return nil, err
	}
	matcher := &gitignoreMatcher{
		baseDir: dir,
		rules:   parseGitignoreRules(string(data)),
	}

	f.matcherMu.Lock()
	f.matcherCache[dir] = matcher
	f.matcherLoaded[dir] = true
	f.matcherMu.Unlock()
	return matcher, nil
}

func parseGitignoreRules(content string) []gitignoreRule {
	lines := strings.Split(content, "\n")
	rules := make([]gitignoreRule, 0, len(lines))
	for _, line := range lines {
		if rule, ok := parseGitignoreRule(line); ok {
			rules = append(rules, rule)
		}
	}
	return rules
}

func parseGitignoreRule(line string) (gitignoreRule, bool) {
	line = strings.TrimRight(line, "\r")
	line = strings.TrimSpace(line)
	if line == "" {
		return gitignoreRule{}, false
	}

	if strings.HasPrefix(line, `\#`) || strings.HasPrefix(line, `\!`) {
		line = line[1:]
	} else if strings.HasPrefix(line, "#") {
		return gitignoreRule{}, false
	}

	negated := false
	if strings.HasPrefix(line, "!") {
		negated = true
		line = strings.TrimPrefix(line, "!")
	}
	if line == "" {
		return gitignoreRule{}, false
	}

	dirOnly := strings.HasSuffix(line, "/")
	line = strings.TrimSuffix(line, "/")
	line = strings.TrimPrefix(line, "/")
	line = filepath.ToSlash(line)
	if line == "" {
		return gitignoreRule{}, false
	}

	return gitignoreRule{
		pattern:  line,
		negated:  negated,
		dirOnly:  dirOnly,
		hasSlash: strings.Contains(line, "/"),
	}, true
}

func (m *gitignoreMatcher) Match(absPath string, isDir bool) (bool, bool) {
	rel, err := filepath.Rel(m.baseDir, absPath)
	if err != nil {
		return false, false
	}
	if rel == "." {
		return false, false
	}
	rel = filepath.ToSlash(rel)
	base := filepath.Base(rel)

	matched := false
	ignored := false
	for _, rule := range m.rules {
		if !rule.matches(rel, base, isDir) {
			continue
		}
		matched = true
		ignored = !rule.negated
	}
	return matched, ignored
}

func (r gitignoreRule) matches(relPath, baseName string, isDir bool) bool {
	if r.dirOnly && !isDir {
		return false
	}
	target := baseName
	if r.hasSlash {
		target = relPath
	}
	ok, err := doublestar.PathMatch(r.pattern, target)
	return err == nil && ok
}
