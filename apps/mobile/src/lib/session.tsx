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
  me: Me | undefined; loading: boolean; error: unknown; loggedIn: boolean;
  can: (module: string, action?: string) => boolean;
  isDoctor: boolean;
  clinics: Scope[]; clinic: Scope | undefined; setClinic: (id: string) => void;
  logout: () => Promise<void>;
}
const SessionCtx = createContext<Ctx>(null as any);
const CLINIC_KEY = 'palmora.clinic';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loggedIn, setLoggedIn] = useState(auth.isLoggedIn);
  const qc = useQueryClient();
  useEffect(() => auth.onChange(() => { setLoggedIn(auth.isLoggedIn); if (!auth.isLoggedIn) qc.clear(); }), [qc]);
  const meQ = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), enabled: loggedIn, staleTime: 60_000, refetchInterval: 120_000 });
  const me = meQ.data;
  const [clinicId, setClinicId] = useState<string | null>(() => { try { return localStorage.getItem(CLINIC_KEY); } catch { return null; } });

  const value = useMemo<Ctx>(() => {
    const clinics = (me?.scopes ?? []).filter((s) => s.unit_type === 'CLINIC').sort((a, b) => a.name.localeCompare(b.name));
    const clinic = clinics.find((c) => c.id === clinicId) ?? clinics.find((c) => c.id === me?.user.staff?.home_clinic_id) ?? clinics[0];
    return {
      me, loading: meQ.isLoading, error: meQ.error, loggedIn,
      can: (m, a = 'READ') => !!me?.permissions?.[m]?.includes(a),
      isDoctor: me?.user.staff?.staff_type === 'DOCTOR',
      clinics, clinic,
      setClinic: (id) => { try { localStorage.setItem(CLINIC_KEY, id); } catch { /* ignore */ } setClinicId(id); },
      logout: async () => {
        try { await api.post('/auth/logout', { refreshToken: auth.refreshToken }); } catch { /* offline: the token expires on its own */ }
        auth.set(null);
      },
    };
  }, [me, meQ.isLoading, meQ.error, loggedIn, clinicId]);

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);
