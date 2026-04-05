package runtimeauth

import "context"

type runtimeSessionContextKey struct{}
type runtimeAuthorizationContextKey struct{}

type RuntimeAuthorization struct {
	GrantIDs   []string
	GrantScope string
	RetryNonce string
	GrantSpecs []map[string]interface{}
}

func (authorization RuntimeAuthorization) IsServerAuthorized() bool {
	return len(authorization.GrantIDs) > 0 || len(authorization.GrantSpecs) > 0
}

func ContextWithRuntimeSessionID(ctx context.Context, runtimeSessionID string) context.Context {
	if runtimeSessionID == "" {
		return ctx
	}
	return context.WithValue(ctx, runtimeSessionContextKey{}, runtimeSessionID)
}

func RuntimeSessionIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	value, _ := ctx.Value(runtimeSessionContextKey{}).(string)
	return value
}

func ContextWithRuntimeAuthorization(
	ctx context.Context,
	authorization RuntimeAuthorization,
) context.Context {
	if len(authorization.GrantIDs) == 0 && authorization.GrantScope == "" && authorization.RetryNonce == "" && len(authorization.GrantSpecs) == 0 {
		return ctx
	}
	return context.WithValue(ctx, runtimeAuthorizationContextKey{}, authorization)
}

func RuntimeAuthorizationFromContext(ctx context.Context) RuntimeAuthorization {
	if ctx == nil {
		return RuntimeAuthorization{}
	}
	value, _ := ctx.Value(runtimeAuthorizationContextKey{}).(RuntimeAuthorization)
	return value
}

func HasServerAuthorization(ctx context.Context) bool {
	return RuntimeAuthorizationFromContext(ctx).IsServerAuthorized()
}
