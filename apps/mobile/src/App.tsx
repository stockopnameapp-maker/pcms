import { useEffect, useState } from 'react';
import { ListOrdered, Search, UserRound } from 'lucide-react';
import { auth, server } from './lib/api';
import { useSession } from './lib/session';
import { Route, switchTab, useRoute } from './lib/router';
import { Login, ServerSetup } from './pages/Welcome';
import Queue from './pages/Queue';
import Encounter from './pages/Encounter';
import Patients, { PatientDetail } from './pages/Patients';
import Account from './pages/Account';
import { ErrorBox, Loading, cx } from './components/ui';

const TABS: { route: Route; label: string; icon: typeof ListOrdered }[] = [
  { route: { name: 'queue' }, label: 'Antrian', icon: ListOrdered },
  { route: { name: 'patients' }, label: 'Pasien', icon: Search },
  { route: { name: 'account' }, label: 'Akun', icon: UserRound },
];

function TabBar({ active }: { active: string }) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-line safe-bottom" aria-label="Navigasi utama">
      <div className="grid grid-cols-3 h-[64px]">
        {TABS.map((t) => {
          const on = active === t.route.name;
          return (
            <button key={t.route.name} onClick={() => switchTab(t.route)} aria-current={on ? 'page' : undefined}
              className={cx('flex flex-col items-center justify-center gap-0.5 text-[12.5px]', on ? 'text-canopy-700 font-medium' : 'text-bark')}>
              <span className={cx('px-5 py-1 rounded-full', on && 'bg-canopy-100')}><t.icon className="w-5 h-5" aria-hidden /></span>{t.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export default function App() {
  const [hasServer, setHasServer] = useState(!!server.url);
  const [editServer, setEditServer] = useState(false);
  const { loggedIn, me, loading, error, logout } = useSession();
  const route = useRoute();
  useEffect(() => auth.onChange(() => setHasServer(!!server.url)), []);

  if (!hasServer || editServer) return <ServerSetup onDone={() => { setEditServer(false); setHasServer(true); }} />;
  if (!loggedIn) return <Login onChangeServer={() => setEditServer(true)} />;
  if (loading) return <div className="min-h-screen grid place-items-center"><Loading /></div>;
  if (error || !me) return <div className="p-6 space-y-4 safe-top"><ErrorBox error={error ?? new Error('Profil tidak dapat dimuat')} /><button className="btn-secondary w-full" onClick={logout}>Masuk ulang</button></div>;

  const tab = ['encounter'].includes(route.name) ? 'queue' : route.name === 'patient' ? 'patients' : route.name;
  return (
    <div className="min-h-screen">
      {route.name === 'queue' && <Queue />}
      {route.name === 'patients' && <Patients />}
      {route.name === 'account' && <Account onChangeServer={async () => { await logout(); server.set(null); setHasServer(false); }} />}
      {route.name === 'encounter' && <Encounter key={route.id} id={route.id} />}
      {route.name === 'patient' && <PatientDetail key={route.id} id={route.id} />}
      <TabBar active={tab} />
    </div>
  );
}
