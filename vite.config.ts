import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      resolve: {
        alias: {
          '@': new URL('.', import.meta.url).pathname,
        }
      }
    };
});