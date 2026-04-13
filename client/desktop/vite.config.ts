/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const authToken = env.SENTRY_AUTH_TOKEN || process.env.SENTRY_AUTH_TOKEN;

  return {
    plugins: [
      react(),
      // Sentry plugin MUST be after all other plugins per the docs.
      // disable: !authToken makes local dev builds work without upload credentials.
      sentryVitePlugin({
        org: 'concord-voice',
        project: 'concord-voice-desktop',
        authToken,
        release: {
          name: process.env.npm_package_version
            ? `concord-desktop@${process.env.npm_package_version}`
            : undefined,
        },
        sourcemaps: {
          filesToDeleteAfterUpload: ['./dist/renderer/**/*.map'],
        },
        disable: !authToken,
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@shared': path.resolve(__dirname, '../../shared'),
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}', 'scripts/**/*.test.{ts,tsx}'],
      testTimeout: 10000,
      hookTimeout: 10000,
      teardownTimeout: 5000,
      coverage: {
        provider: 'istanbul',
        reporter: ['text', 'html', 'lcov'],
        include: ['src/renderer/**/*.{ts,tsx}', 'src/shared/**/*.{ts,tsx}'],
        exclude: ['src/renderer/types/**', '**/*.d.ts'],
        // Coverage thresholds enforced by SonarQube Quality Gate, not here.
      },
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@shared': path.resolve(__dirname, '../../shared'),
      },
    },
    server: {
      port: 3001,
      strictPort: true,
    },
    build: {
      outDir: 'dist/renderer',
      sourcemap: 'hidden',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
        },
        output: {
          manualChunks(id) {
            if (
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-router-dom/')
            ) {
              return 'vendor-react';
            }
            if (id.includes('node_modules/zustand/')) {
              return 'vendor-zustand';
            }
            if (id.includes('node_modules/lucide-react/')) {
              return 'vendor-icons';
            }
          },
        },
      },
    },
    base: './',
  };
});
