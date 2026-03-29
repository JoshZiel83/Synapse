import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ApiError, api, setApiAuthToken } from '@/lib/api';
import { deleteStoredValue, readStoredValue, writeStoredValue } from '@/lib/storage';
import type { AuthMeResponse } from '@/types/api';
import type { AuthSessionSummary, User } from '@shared';

const SESSION_TOKEN_KEY = 'synapse.mobile.sessionToken';

type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface SessionContextValue {
  status: SessionStatus;
  user: User | null;
  session: AuthSessionSummary | null;
  token: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
  updateProfile: (data: { name?: string; avatarFileId?: string | null }) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

async function persistSessionToken(token: string | null) {
  if (token) {
    await writeStoredValue(SESSION_TOKEN_KEY, token);
    return;
  }

  await deleteStoredValue(SESSION_TOKEN_KEY);
}

function applySession(
  payload: {
    token: string | null;
    response?: AuthMeResponse | { user: User; session: AuthSessionSummary } | null;
  },
  setState: React.Dispatch<
    React.SetStateAction<{
      status: SessionStatus;
      user: User | null;
      session: AuthSessionSummary | null;
      token: string | null;
    }>
  >,
) {
  setApiAuthToken(payload.token);
  setState({
    status: payload.response ? 'authenticated' : 'unauthenticated',
    token: payload.token,
    user: payload.response?.user ?? null,
    session: payload.response?.session ?? null,
  });
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    status: SessionStatus;
    user: User | null;
    session: AuthSessionSummary | null;
    token: string | null;
  }>({
    status: 'loading',
    user: null,
    session: null,
    token: null,
  });

  const clearSession = useCallback(async () => {
    await persistSessionToken(null);
    applySession({ token: null }, setState);
  }, []);

  const refreshSession = useCallback(async () => {
    const storedToken = await readStoredValue(SESSION_TOKEN_KEY);
    if (!storedToken) {
      applySession({ token: null }, setState);
      return;
    }

    setApiAuthToken(storedToken);

    try {
      const response = await api.getMe();
      applySession({ token: storedToken, response }, setState);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        await clearSession();
        return;
      }

      setApiAuthToken(storedToken);
      setState((current) => ({
        ...current,
        status: 'authenticated',
        token: storedToken,
      }));
    }
  }, [clearSession]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await api.login(email, password);
    if (!response.sessionToken) {
      throw new ApiError('The server did not return a mobile session token.', 500);
    }

    await persistSessionToken(response.sessionToken);
    applySession(
      {
        token: response.sessionToken,
        response: {
          user: response.user,
          session: response.session,
        },
      },
      setState,
    );
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Ignore sign out transport issues and clear the local token anyway.
    }

    await clearSession();
  }, [clearSession]);

  const updateProfile = useCallback(
    async (data: { name?: string; avatarFileId?: string | null }) => {
      const response = await api.updateMe(data);
      setState((current) => ({
        ...current,
        user: response.user,
        session: response.session ?? current.session,
      }));
    },
    [],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      status: state.status,
      user: state.user,
      session: state.session,
      token: state.token,
      signIn,
      signOut,
      refreshSession,
      updateProfile,
    }),
    [refreshSession, signIn, signOut, state.session, state.status, state.token, state.user, updateProfile],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside SessionProvider.');
  }

  return value;
}
