import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Opt { value: string; label: string }
export interface FieldDef {
  name: string; label: string; type: 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'time' | 'select' | 'boolean' | 'ref' | 'tags';
  required?: boolean; options?: Opt[]; ref?: string; refParams?: Record<string, string>; min?: number; max?: number; maxLength?: number; pattern?: string;
  patternMessage?: string; create?: boolean; update?: boolean; help?: string; default?: any; wide?: boolean; group?: string;
}
export interface ColumnDef { name: string; label: string; kind?: string }
export interface FilterDef { name: string; label: string; type: 'select' | 'ref' | 'date'; options?: Opt[]; ref?: string; refParams?: Record<string, string> }
export interface ResourceMeta {
  key: string; title: string; singular: string; module: string; table: string; columns: ColumnDef[]; fields: FieldDef[]; filters: FilterDef[];
  titleField: string; workflow?: string; group: string; scoped: boolean; sort: string; noCreate?: boolean; noUpdate?: boolean; noDelete?: boolean;
  permissions: { read: boolean; create: boolean; update: boolean; delete: boolean; export: boolean };
}
export interface Transition { entity: string; from_status: string; to_status: string; required_action: string; label: string }

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => api.get<{ resources: ResourceMeta[]; transitions: Transition[] }>('/meta/resources'), staleTime: 5 * 60_000 });
}
export function useResourceMeta(key: string) {
  const m = useMeta();
  return { ...m, resource: m.data?.resources.find((r) => r.key === key) };
}
