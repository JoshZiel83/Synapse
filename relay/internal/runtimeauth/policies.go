package runtimeauth

import (
	"context"
	"path/filepath"
	"sort"
	"strings"
)

// Struct definitions for FilesystemPolicy, CUAPolicy, BrowserPolicy,
// CommandlinePolicy, and GrantPolicy now live in policies_gen.go, which is
// generated from the Zod schemas in
// packages/shared/src/access/policies/*.ts via
// scripts/codegen/relay-policies.ts. To change a field, edit the Zod schema
// and run `npm run codegen:relay-policies`.

func normalizePathPrefix(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	return filepath.Clean(trimmed)
}

func normalizePathPrefixes(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		prefix := normalizePathPrefix(value)
		if prefix == "" {
			continue
		}
		if _, exists := seen[prefix]; exists {
			continue
		}
		seen[prefix] = struct{}{}
		normalized = append(normalized, prefix)
	}
	// P4: sort for cross-language determinism — the TS side calls .sort() on
	// the same normalized list, and any code path that compares or hashes the
	// list across the boundary must see identical ordering.
	sort.Strings(normalized)
	return normalized
}

func normalizeGrantPolicy(policy GrantPolicy) GrantPolicy {
	policy.Capability = strings.TrimSpace(strings.ToLower(policy.Capability))
	if policy.Filesystem != nil {
		policy.Filesystem.Access = strings.TrimSpace(strings.ToLower(policy.Filesystem.Access))
		policy.Filesystem.PathPrefixes = normalizePathPrefixes(policy.Filesystem.PathPrefixes)
	}
	if policy.CUA != nil {
		policy.CUA.Access = strings.TrimSpace(strings.ToLower(policy.CUA.Access))
	}
	if policy.Browser != nil {
		policy.Browser.Action = strings.TrimSpace(strings.ToLower(policy.Browser.Action))
		policy.Browser.ScopeType = strings.TrimSpace(strings.ToLower(policy.Browser.ScopeType))
		policy.Browser.Origin = strings.TrimSpace(policy.Browser.Origin)
		policy.Browser.Host = strings.TrimSpace(strings.ToLower(policy.Browser.Host))
		policy.Browser.RegistrableDomain = strings.TrimSpace(strings.ToLower(policy.Browser.RegistrableDomain))
	}
	if policy.Commandline != nil {
		policy.Commandline.Executor = strings.TrimSpace(strings.ToLower(policy.Commandline.Executor))
		policy.Commandline.CommandMatchType = strings.TrimSpace(strings.ToLower(policy.Commandline.CommandMatchType))
		policy.Commandline.CommandText = strings.TrimSpace(policy.Commandline.CommandText)
		policy.Commandline.WorkingDirectory = normalizePathPrefix(policy.Commandline.WorkingDirectory)
	}
	return policy
}

// P4 contract: `RuntimeAuthorization.GrantSpecs` is now `[]GrantPolicy`
// (strongly typed at unmarshal). The historical `decodeGrantPolicy` step
// that re-marshaled `map[string]interface{}` into a GrantPolicy is gone.
func (authorization RuntimeAuthorization) Policies() []GrantPolicy {
	if len(authorization.GrantSpecs) == 0 {
		return nil
	}
	policies := make([]GrantPolicy, 0, len(authorization.GrantSpecs))
	for _, raw := range authorization.GrantSpecs {
		policy := normalizeGrantPolicy(raw)
		if policy.Capability == "" {
			continue
		}
		policies = append(policies, policy)
	}
	return policies
}

func PoliciesFromContext(ctx context.Context) []GrantPolicy {
	return RuntimeAuthorizationFromContext(ctx).Policies()
}

func PoliciesForCapability(ctx context.Context, capability string) []GrantPolicy {
	capability = strings.TrimSpace(strings.ToLower(capability))
	policies := PoliciesFromContext(ctx)
	if capability == "" || len(policies) == 0 {
		return policies
	}
	filtered := make([]GrantPolicy, 0, len(policies))
	for _, policy := range policies {
		if policy.Capability == capability {
			filtered = append(filtered, policy)
		}
	}
	return filtered
}

func pathWithinPrefix(target string, prefix string) bool {
	if target == prefix {
		return true
	}
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return strings.HasPrefix(target, prefix)
}

func normalizeCommandText(value string) string {
	return strings.TrimSpace(value)
}

func hasCompoundShellOperators(command string) bool {
	return strings.Contains(command, "&&") ||
		strings.Contains(command, "||") ||
		strings.Contains(command, ";") ||
		strings.Contains(command, "|") ||
		strings.Contains(command, "\n")
}

func commandPrefixMatches(prefix string, command string) bool {
	return command == prefix || strings.HasPrefix(command, prefix+" ")
}

func MatchesFilesystemPolicy(
	policies []GrantPolicy,
	access string,
	pathPrefixes []string,
) bool {
	normalizedAccess := strings.TrimSpace(strings.ToLower(access))
	normalizedPrefixes := normalizePathPrefixes(pathPrefixes)
	if normalizedAccess == "" || len(normalizedPrefixes) == 0 {
		return false
	}
	for _, policy := range policies {
		if policy.Capability != "filesystem" || policy.Filesystem == nil {
			continue
		}
		if policy.Filesystem.Access != normalizedAccess || len(policy.Filesystem.PathPrefixes) == 0 {
			continue
		}
		matchedAll := true
		for _, requestedPrefix := range normalizedPrefixes {
			matchedPrefix := false
			for _, grantedPrefix := range policy.Filesystem.PathPrefixes {
				if pathWithinPrefix(requestedPrefix, grantedPrefix) {
					matchedPrefix = true
					break
				}
			}
			if !matchedPrefix {
				matchedAll = false
				break
			}
		}
		if matchedAll {
			return true
		}
	}
	return false
}

func FilesystemRootsFromPolicies(policies []GrantPolicy) []FilesystemPolicy {
	roots := make([]FilesystemPolicy, 0, len(policies))
	for _, policy := range policies {
		if policy.Capability != "filesystem" || policy.Filesystem == nil {
			continue
		}
		roots = append(roots, *policy.Filesystem)
	}
	return roots
}

func MatchesCUAPolicy(policies []GrantPolicy, access string) bool {
	normalizedAccess := strings.TrimSpace(strings.ToLower(access))
	for _, policy := range policies {
		if policy.Capability == "cua" && policy.CUA != nil && policy.CUA.Access == normalizedAccess {
			return true
		}
	}
	return false
}

func MatchesBrowserPolicy(
	policies []GrantPolicy,
	action string,
	origin string,
	host string,
	registrableDomain string,
) bool {
	normalizedAction := strings.TrimSpace(strings.ToLower(action))
	normalizedOrigin := strings.TrimSpace(origin)
	normalizedHost := strings.TrimSpace(strings.ToLower(host))
	normalizedDomain := strings.TrimSpace(strings.ToLower(registrableDomain))
	for _, policy := range policies {
		if policy.Capability != "browser" || policy.Browser == nil || policy.Browser.Action != normalizedAction {
			continue
		}
		switch policy.Browser.ScopeType {
		case "origin":
			if policy.Browser.Origin != "" && policy.Browser.Origin == normalizedOrigin {
				return true
			}
		case "host":
			if policy.Browser.Host != "" && policy.Browser.Host == normalizedHost {
				return true
			}
		case "domain":
			if policy.Browser.RegistrableDomain != "" && policy.Browser.RegistrableDomain == normalizedDomain {
				return true
			}
		default:
			// P4: previously `return true` — that was a dangerous default that
			// silently granted access when a policy stored an unknown scopeType.
			// Safer to deny and let callers explicitly add new scope types.
			continue
		}
	}
	return false
}

func MatchesCommandlinePolicy(
	policies []GrantPolicy,
	executor string,
	command string,
	workingDirectory string,
) bool {
	normalizedExecutor := strings.TrimSpace(strings.ToLower(executor))
	normalizedCommand := normalizeCommandText(command)
	normalizedWorkingDirectory := normalizePathPrefix(workingDirectory)
	if normalizedExecutor == "" || normalizedCommand == "" {
		return false
	}
	for _, policy := range policies {
		if policy.Capability != "commandline" || policy.Commandline == nil {
			continue
		}
		if policy.Commandline.Executor != normalizedExecutor {
			continue
		}
		if policy.Commandline.WorkingDirectory != "" {
			if normalizedWorkingDirectory == "" || !pathWithinPrefix(normalizedWorkingDirectory, policy.Commandline.WorkingDirectory) {
				continue
			}
		}
		switch policy.Commandline.CommandMatchType {
		case "exact":
			if policy.Commandline.CommandText == normalizedCommand {
				return true
			}
		case "prefix":
			if policy.Commandline.CommandText != "" &&
				!hasCompoundShellOperators(normalizedCommand) &&
				commandPrefixMatches(policy.Commandline.CommandText, normalizedCommand) {
				return true
			}
		case "tool":
			return true
		}
	}
	return false
}
