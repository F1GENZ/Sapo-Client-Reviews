import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const firstHttpUrl = (...values: Array<string | undefined>): string => {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && /^https?:\/\//i.test(trimmed)) return trimmed;
  }
  return 'http://127.0.0.1:3333';
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = firstHttpUrl(env.VITE_DEV_API_PROXY_TARGET, env.VITE_API_BASE_URL);

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-antd': ['antd'],
            'vendor-query': ['@tanstack/react-query', 'axios'],
          },
        },
      },
    },
  };
});
