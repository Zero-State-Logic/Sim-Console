/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/*
 * Production CSP, injected as a <meta> so it also applies on GitHub Pages (no custom
 * headers there). 'wasm-unsafe-eval' is for the Rapier physics WASM. The code sandbox
 * worker is a separate script file, so this document policy does not apply to it.
 * ws:/wss: are open because the hardware bridge connects to boards at user-given IPs.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

function cspMeta(): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${CSP}">`),
  }
}

// base './' keeps every asset path relative, so the same build works on
// GitHub Pages (/<repo>/), Vercel, Netlify and Cloudflare Pages without changes.
export default defineConfig({
  base: './',
  plugins: [react(), cspMeta()],
  worker: { format: 'es' },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          post: ['postprocessing', '@react-three/postprocessing'],
          editor: ['@uiw/react-codemirror', '@codemirror/lang-cpp', '@codemirror/lang-javascript'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tools/**/*.test.ts', 'electron/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts', 'src/**/ui/**'] },
  },
})
