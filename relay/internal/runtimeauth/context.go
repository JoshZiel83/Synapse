package runtimeauth

import "context"

type runtimeSessionContextKey struct{}
type runtimeAuthorizationContextKey struct{}

type RuntimeAuthorization struct {
	GrantID    string
	GrantScope string
	RetryNonce string
	Effect     map[string]interface{}
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
	if authorization.GrantID == "" && authorization.GrantScope == "" && authorization.RetryNonce == "" && len(authorization.Effect) == 0 {
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
