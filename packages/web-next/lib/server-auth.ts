import 'server-only';

import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import type { AuthSessionSummary, User } from '@synapse/shared';
import { AUTH_SESSION_COOKIE_NAME } from '@synapse/shared';
import { buildApiProxyUrl } from '@/lib/api-origin';

export interface ServerAuthState {
  status: 'authenticated' | 'unauthenticated' | 'unavailable';
  user: User | null;
  session: AuthSessionSummary | null;
}

export const getServerAuthState = cache(async (): Promise<ServerAuthState> => {
  const cookieStore = await cookies();
  if (!cookieStore.get(AUTH_SESSION_COOKIE_NAME)?.value) {
    return { status: 'unauthenticated', user: null, session: null };
  }

  const requestHeaders = await headers();

  try {
    const response = await fetch(buildApiProxyUrl('/auth/me'), {
      method: 'GET',
      headers: {
        cookie: cookieStore.toString(),
        'user-agent': requestHeaders.get('user-agent') ?? '',
        'x-forwarded-for': requestHeaders.get('x-forwarded-for') ?? '',
        'x-forwarded-proto': requestHeaders.get('x-forwarded-proto') ?? '',
        'x-forwarded-host': requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host') ?? '',
      },
      cache: 'no-store',
    });

    if (response.status === 401) {
      return { status: 'unauthenticated', user: null, session: null };
    }

    if (!response.ok) {
      return { status: 'unavailable', user: null, session: null };
    }

    const payload = await response.json() as {
      user?: User;
      session?: AuthSessionSummary;
    };

    return {
      status: 'authenticated',
      user: payload.user ?? null,
      session: payload.session ?? null,
    };
  } catch {
    return { status: 'unavailable', user: null, session: null };
  }
});
