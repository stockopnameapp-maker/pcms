// Minimal hash router: works the same from the APK (file-like origin) and a dev server, and lets the Android
// back button walk back through screens with history.back().
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'queue' } | { name: 'patients' } | { name: 'account' }
  | { name: 'encounter'; id: string } | { name: 'patient'; id: string };

export function parse(hash: string): Route {
  const [a, b] = hash.replace(/^#\/?/, '').split('?')[0].split('/');
  if (a === 'encounter' && b) return { name: 'encounter', id: b };
  if (a === 'patient' && b) return { name: 'patient', id: b };
  if (a === 'patients') return { name: 'patients' };
  if (a === 'account') return { name: 'account' };
  return { name: 'queue' };
}

export const href = (r: Route) => '#/' + r.name + ('id' in r ? '/' + r.id : '');
export const go = (r: Route) => { window.location.hash = href(r); };
/** Tabs replace the current entry so the back button leaves the app instead of cycling through tabs. */
export const switchTab = (r: Route) => { window.location.replace(href(r)); };

export function useRoute(): Route {
  const [r, setR] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => { setR(parse(window.location.hash)); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}
