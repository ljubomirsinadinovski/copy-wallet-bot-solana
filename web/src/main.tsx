import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import './index.css';
import { api, type AuthStatus } from './lib/api';
import { useLiveUpdates } from './lib/live';
import { Layout } from './components/Layout';
import { Toasts } from './components/ui';
import { Login } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { PositionsPage } from './pages/Positions';
import { TradersPage } from './pages/Traders';
import { WalletsPage } from './pages/Wallets';
import { WalletDetailPage } from './pages/WalletDetail';
import { TradesPage } from './pages/Trades';
import { LogsPage } from './pages/Logs';
import { SettingsPage } from './pages/Settings';
import { BacktestPage } from './pages/Backtest';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: true } },
});

function App() {
  const qc = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => api<AuthStatus>('/auth/status') });
  const loggedIn = Boolean(auth.data?.loggedIn);
  useLiveUpdates(qc, loggedIn);

  useEffect(() => {
    const onLost = () => void qc.invalidateQueries({ queryKey: ['auth'] });
    window.addEventListener('auth-lost', onLost);
    return () => window.removeEventListener('auth-lost', onLost);
  }, [qc]);

  if (auth.isLoading) return null;
  if (auth.error) return <div className="p-8 text-loss">Can’t reach the bot server. Is it running?</div>;
  if (!loggedIn) return <Login firstRun={!auth.data!.setup} minLength={auth.data!.minPassphrase} />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/positions" element={<PositionsPage />} />
        <Route path="/traders" element={<TradersPage />} />
        <Route path="/wallets" element={<WalletsPage />} />
        <Route path="/wallets/:id" element={<WalletDetailPage />} />
        <Route path="/trades" element={<TradesPage />} />
        <Route path="/backtest" element={<BacktestPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </Layout>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toasts />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
