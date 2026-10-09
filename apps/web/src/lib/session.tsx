import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, auth } from './api';

export interface Scope { id: string; name: string; unit_type: string; code: string; depth: number; parent_id: string | null }
export interface Me {
  user: { id: string; username: string; full_name: string; email: string; home_unit_name: string; tenant_name: string; tenant_code: string; mfa_enabled: boolean;
    must_change_password: boolean; employee_id: string | null; staff: { id: string; staff_type: string; home_clinic_id: string } | null };
  roles: { code: string; name: string; scope_id: string; scope_name: string; scope_type: string }[];
  permissions: Record<string, string[]>;
  scopes: Scope[];
  unreadNotifications: number;
}

interface Ctx {
  me: Me | undefined; loading: boolean; loggedIn: boolean;
  can: (module: string, action?: string) => boolean;
  scope: Scope | undefined; setScope: (id: string) => void; scopeChain: Scope[];
  refreshMe: () => void; logout: () => Promise<void>;
}
const SessionCtx = createContext<Ctx>(null as any);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loggedIn, setLoggedIn] = useState(auth.isLoggedIn);
  const qc = useQueryClient();
  useEffect(() => { const off = auth.onChange(() => { setLoggedIn(auth.isLoggedIn); if (!auth.isLoggedIn) qc.clear(); }); return () => { off(); }; }, [qc]);
  const meQ = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), enabled: loggedIn, staleTime: 60_000, refetchInterval: 60_000 });
  const me = meQ.data;
  const [scopeId, setScopeId] = useState<string | null>(() => sessionStorage.getItem('pcms.scope'));

  const value = useMemo<Ctx>(() => {
    const scopes = me?.scopes ?? [];
    const byId = new Map(scopes.map((s) => [s.id, s]));
    const top = scopes.reduce<Scope | undefined>((a, s) => (!a || s.depth < a.depth ? s : a), undefined);
    const scope = (scopeId && byId.get(scopeId)) || (me?.user.staff ? byId.get(me.user.staff.home_clinic_id) : undefined) || top;
    const chain: Scope[] = [];
    for (let s = scope; s; s = s.parent_id ? byId.get(s.parent_id) : undefined) chain.unshift(s);
    return {
      me, loading: meQ.isLoading, loggedIn,
      can: (m, a = 'READ') => !!me?.permissions?.[m]?.includes(a),
      scope, scopeChain: chain,
      setScope: (id) => { sessionStorage.setItem('pcms.scope', id); setScopeId(id); },
      refreshMe: () => meQ.refetch(),
      logout: async () => {
        const raw = sessionStorage.getItem('pcms.session');
        try { await api.post('/auth/logout', { refreshToken: raw ? JSON.parse(raw).refreshToken : undefined }); } catch { /* ignore */ }
        sessionStorage.removeItem('pcms.scope');
        auth.set(null);
      },
    };
  }, [me, meQ.isLoading, loggedIn, scopeId]);

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);
