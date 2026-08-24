'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ROLES, type AuthUser, type Role } from '@safecheck/shared';
import { api, onSessionChange, restoreSession } from './api';

/**
 * Session state for the React tree.
 *
 * The access token deliberately does not survive a reload (see lib/api.ts), so
 * every load begins in `loading` and asks the refresh cookie whether there is a
 * session to restore. That is the one unavoidable consequence of keeping the
 * token out of storage, and it is why authenticated screens are client
 * components: the server has no token to render them with.
 */

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  user: AuthUser | null;
  status: SessionStatus;
  signIn: (email: string, password: string) => Promise<AuthUser>;
  signOut: () => Promise<void>;
  /** Replaces the cached user, e.g. after verifying an email in this tab. */
  setUser: (user: AuthUser | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Restore runs once per page load, not once per mount. React's development
 * StrictMode mounts every effect twice, and a second refresh would present a
 * token the first had already rotated away — which the API correctly reads as
 * replay and answers by revoking the session. The client dedupes concurrent
 * refreshes anyway; this guard covers the case where the remount lands after the
 * first one has resolved.
 */
let bootstrapped = false;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<SessionStatus>('loading');

  useEffect(() => {
    // The client pushes user changes here: a background refresh can return an
    // updated role or verification flag, and a failed one ends the session.
    onSessionChange((next) => {
      setUser(next);
      setStatus(next ? 'authenticated' : 'anonymous');
    });

    if (bootstrapped) {
      // A remount after the first restore already settled things.
      setStatus((current) => (current === 'loading' ? 'anonymous' : current));
      return () => onSessionChange(null);
    }
    bootstrapped = true;

    void restoreSession().then((restored) => {
      setUser(restored);
      setStatus(restored ? 'authenticated' : 'anonymous');
    });

    return () => onSessionChange(null);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    // `api.login` notifies the session listener itself, which is what moves
    // `status` to authenticated — no second state write needed here.
    return api.login({ email, password });
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, status, signIn, signOut, setUser }),
    [user, status, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/* --------------------------------------------------------------------- roles */

/** Rank within ROLES: user < moderator < admin. */
export function roleAtLeast(role: Role | undefined, minimum: Role): boolean {
  if (!role) return false;
  return ROLES.indexOf(role) >= ROLES.indexOf(minimum);
}

/**
 * Redirect anonymous visitors to sign-in, and under-privileged ones away from a
 * screen they cannot use.
 *
 * This is navigation, not authorisation. Every one of these endpoints is guarded
 * server-side; hiding a screen the API would refuse anyway is a courtesy so the
 * user is not shown a page that can only produce 403s.
 */
export function useRequireAuth(minimum: Role = 'user'): AuthState {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (auth.status === 'loading') return;
    if (auth.status === 'anonymous') {
      router.replace('/login');
      return;
    }
    if (!roleAtLeast(auth.user?.role, minimum)) router.replace('/reports');
  }, [auth.status, auth.user?.role, minimum, router]);

  return auth;
}
