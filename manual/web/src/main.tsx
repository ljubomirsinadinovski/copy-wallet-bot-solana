import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './app.css';
import { Toasts } from '../../../web/src/components/ui';
import { App } from './App';

// Nothing reloads on a timer: data loads when the page opens, on Refresh, and after each trade.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toasts />
    </QueryClientProvider>
  </StrictMode>,
);
