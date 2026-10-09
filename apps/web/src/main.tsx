import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Plus, Truck } from 'lucide-react';
import './index.css';
import { SessionProvider, useSession } from './lib/session';
import { AppLayout } from './components/Layout';
import { ResourcePage } from './components/ResourcePage';
import { Empty, Loading, ToastProvider } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Queue from './pages/Queue';
import Encounter from './pages/Encounter';
import PatientTimeline from './pages/PatientTimeline';
import { Dispense, DispenseList, OpnameDetail, OpnameNewButton, PurchaseOrderDetail, PurchaseOrderNew, Stock, TransferDetail, TransferRequestModal } from './pages/Pharmacy';
import { AlertsPage, AmbulanceBoard, LabWorklist, McuDetail, OccCompliance, OccEmployee } from './pages/Clinical';
import Finance from './pages/Finance';
import Reports from './pages/Reports';
import { AdminRoles, AdminUsers, Audit, OrgTree } from './pages/Admin';
import Profile, { ForcePasswordChange } from './pages/Profile';
import Portal, { Verify } from './pages/Portal';

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, e: any) => n < 2 && !(e?.status >= 400 && e?.status < 500), refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

function Landing() {
  const { me, can } = useSession();
  if (!me) return <Loading />;
  const target =
    can('DASHBOARD') ? '/dashboard'
    : can('QUEUE') ? '/queue'
    : can('PHARMACY') ? '/pharmacy/dispense'
    : can('LAB') ? '/lab'
    : can('INVENTORY') ? '/pharmacy/stock'
    : can('OCC_HEALTH') ? '/occ-health'
    : can('ACCIDENT') ? '/r/accidents'
    : can('SICK_LEAVE') ? '/r/sick-leaves'
    : can('EMPLOYEE') ? '/r/employees'
    : can('USER_ADMIN') ? '/admin/users'
    : can('AUDIT') ? '/audit'
    : me.user.employee_id ? '/portal'
    : '/profile';
  return <Navigate to={target} replace />;
}

function PurchaseOrders() {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  return (<>
    <ResourcePage resourceKey="purchase-orders" hideCreate actions={can('INVENTORY', 'CREATE') && <button className="btn-primary" onClick={() => setOpen(true)}><Plus className="w-4 h-4" />PO baru</button>} />
    {open && <PurchaseOrderNew open onClose={() => setOpen(false)} />}
  </>);
}
function Opnames() {
  const { can } = useSession();
  return <ResourcePage resourceKey="stock-opnames" hideCreate actions={can('INVENTORY', 'CREATE') && <OpnameNewButton />} />;
}
function Transfers() {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  return (<>
    <ResourcePage resourceKey="stock-transfers" hideCreate actions={can('INVENTORY', 'CREATE') && <button className="btn-primary" onClick={() => setOpen(true)}><Truck className="w-4 h-4" />Minta transfer</button>} />
    {open && <TransferRequestModal open onClose={() => setOpen(false)} />}
  </>);
}

function GenericResource() {
  const { key } = useParams();
  return <ResourcePage key={key} />;
}

function Authed() {
  const { loggedIn, me, loading } = useSession();
  if (!loggedIn) return <Login />;
  if (loading || !me) return <div className="min-h-screen grid place-items-center"><Loading text="Menyiapkan sesi…" /></div>;
  return (
    <>
      <ForcePasswordChange />
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Landing />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="queue" element={<Queue />} />
          <Route path="emr/:id" element={<Encounter />} />
          <Route path="patients/:id" element={<PatientTimeline />} />
          <Route path="lab" element={<LabWorklist />} />
          <Route path="pharmacy/dispense" element={<DispenseList />} />
          <Route path="pharmacy/dispense/:id" element={<Dispense />} />
          <Route path="pharmacy/stock" element={<Stock />} />
          <Route path="pharmacy/transfers/:id" element={<TransferDetail />} />
          <Route path="pharmacy/purchase-orders/:id" element={<PurchaseOrderDetail />} />
          <Route path="pharmacy/opnames/:id" element={<OpnameDetail />} />
          <Route path="occ-health" element={<OccCompliance />} />
          <Route path="occ-health/employees/:id" element={<OccEmployee />} />
          <Route path="occ-health/mcu/:id" element={<McuDetail />} />
          <Route path="ambulance" element={<AmbulanceBoard />} />
          <Route path="finance" element={<Finance />} />
          <Route path="reports" element={<Reports />} />
          <Route path="audit" element={<Audit />} />
          <Route path="org" element={<OrgTree />} />
          <Route path="admin/users" element={<AdminUsers />} />
          <Route path="admin/roles" element={<AdminRoles />} />
          <Route path="profile" element={<Profile />} />
          <Route path="portal" element={<Portal />} />
          <Route path="r/purchase-orders" element={<PurchaseOrders />} />
          <Route path="r/stock-opnames" element={<Opnames />} />
          <Route path="r/stock-transfers" element={<Transfers />} />
          <Route path="audit/break-glass" element={<ResourcePage resourceKey="break-glass" />} />
          <Route path="r/:key" element={<GenericResource />} />
          <Route path="*" element={<Empty title="Halaman tidak ditemukan" hint="Periksa alamat atau gunakan menu di samping." />} />
        </Route>
      </Routes>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/verify/:code" element={<Verify />} />
            <Route path="/*" element={<SessionProvider><Authed /></SessionProvider>} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
