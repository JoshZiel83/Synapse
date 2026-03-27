package runtimeauth

import "context"

type runtimeSessionContextKey struct{}

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
