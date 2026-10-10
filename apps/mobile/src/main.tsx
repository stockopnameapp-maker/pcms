import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import App from './App';
import { SessionProvider } from './lib/session';
import { ToastProvider } from './components/ui';
import './index.css';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 10_000 } } });

if (Capacitor.isNativePlatform()) {
  StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
  StatusBar.setBackgroundColor({ color: '#0E3B2E' }).catch(() => {});
  // Android back button: close an open sheet first, then walk back through screens, then leave the app.
  CapApp.addListener('backButton', ({ canGoBack }) => {
    const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label^="Tutup"]');
    if (close) { close.click(); return; }
    if (canGoBack && window.location.hash && !/^#\/(queue|patients|account)?$/.test(window.location.hash)) window.history.back();
    else CapApp.minimizeApp();
  });
  // Coming back to the app refreshes the queue and session data.
  CapApp.addListener('resume', () => qc.invalidateQueries());
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
