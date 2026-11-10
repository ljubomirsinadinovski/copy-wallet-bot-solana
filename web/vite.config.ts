import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // The bot's port comes from the project's .env (one level up), same as the server.
  const env = { ...loadEnv(mode, '..', ''), ...process.env };
  const apiPort = env.PORT || '8787';
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      host: '127.0.0.1',
      proxy: {
        '/api': { target: `http://127.0.0.1:${apiPort}`, ws: true },
      },
    },
  };
});
