import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

const apiBase = process.env.VITE_API_BASE ?? '';
const connectSrc = apiBase ? `'self' ${new URL(apiBase).origin}` : "'self'";
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src ${connectSrc}`,
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const headers = {
  'Content-Security-Policy': csp,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cache-Control': 'no-store',
};

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'csp-meta',
      transformIndexHtml(html, ctx) {
        if (ctx.server) return html;
        return html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
      },
    },
  ],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    host: '127.0.0.1',
    port: 41773,
    proxy: { '/api': 'http://127.0.0.1:41774' },
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    },
  },
  preview: { host: '127.0.0.1', port: 41773, headers },
});
