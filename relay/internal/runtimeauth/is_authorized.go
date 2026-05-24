package runtimeauth

import "context"

type AccessRequest struct {
	Capability  string
	Filesystem  *FilesystemRequest
	CUA         *CUARequest
	Browser     *BrowserRequest
	Commandline *CommandlineRequest
}

type FilesystemRequest struct {
	Access       string
	PathPrefixes []string
}

type CUARequest struct {
	Access string
}

type BrowserRequest struct {
	Action            string
	Origin            string
	Host              string
	RegistrableDomain string
}

type CommandlineRequest struct {
	Executor         string
	Command          string
	WorkingDirectory string
}

// IsAuthorized dispatches on req.Capability to the matching per-capability
// policy matcher, using the runtime authorization stored on ctx.
func IsAuthorized(ctx context.Context, req AccessRequest) bool {
	policies := PoliciesForCapability(ctx, req.Capability)
	switch req.Capability {
	case "filesystem":
		if req.Filesystem == nil {
			return false
		}
		return MatchesFilesystemPolicy(policies, req.Filesystem.Access, req.Filesystem.PathPrefixes)
	case "cua":
		if req.CUA == nil {
			return false
		}
		return MatchesCUAPolicy(policies, req.CUA.Access)
	case "browser":
		if req.Browser == nil {
			return false
		}
		return MatchesBrowserPolicy(policies, req.Browser.Action, req.Browser.Origin, req.Browser.Host, req.Browser.RegistrableDomain)
	case "commandline":
		if req.Commandline == nil {
			return false
		}
		return MatchesCommandlinePolicy(policies, req.Commandline.Executor, req.Commandline.Command, req.Commandline.WorkingDirectory)
	default:
		return false
	}
}
