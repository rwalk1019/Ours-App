import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import path from 'node:path';

await build({
  entryPoints: ['supabase/functions/ours-api/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  outfile: 'dist/ours-api.js',
  external: ['npm:postgres', 'npm:postgres@3.4.7'],
  alias: {
    '@ours/domain': path.resolve('packages/domain/src/index.ts'),
  },
  plugins: [
    {
      name: 'ts-extension',
      setup(plugin) {
        plugin.onResolve({ filter: /^\./ }, (args) => {
          const base = path.resolve(args.resolveDir, args.path);
          const ts = base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : `${base}.ts`;
          if (existsSync(ts)) return { path: ts };
          if (existsSync(base)) return { path: base };
          return null;
        });
      },
    },
  ],
});
