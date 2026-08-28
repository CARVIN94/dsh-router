/**
 * Vite client build for dsh-router (React panel + sidebar entry).
 *
 * Output contract: two CJS-closure files consumed by DSH's
 * `window.__ModuleLoader__`:
 *   - `lib/client.js`            → id "dsh-router"              (profile channel)
 *   - `lib/client-registry.js`   → id "dsh-external/dsh-router" (registry channel)
 * Driven by DSH_CLIENT_ID / DSH_CLIENT_FILE env vars; `pnpm build` runs this
 * twice. `react`, `react-dom`, `cordis` stay external (provided by the web
 * shell's frozen module table); everything else is inlined.
 *
 * CSS is injected into the JS (vite-plugin-css-injected-by-js) because the
 * module table only loads one JS closure and will not fetch a sidecar .css.
 */
import { defineConfig } from 'vite'
import cssInjectedByJs from 'vite-plugin-css-injected-by-js'

const CLIENT_ID = process.env.DSH_CLIENT_ID ?? 'dsh-router'
const CLIENT_FILE = process.env.DSH_CLIENT_FILE ?? 'client.js'

export default defineConfig({
  root: process.cwd(),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    'import.meta.hot': 'undefined',
  },
  plugins: [
    cssInjectedByJs(),
  ],
  build: {
    outDir: 'lib',
    emptyOutDir: false, // keep the tsdown-built host (lib/index.js)
    cssCodeSplit: false,
    lib: {
      entry: 'src/client/index.tsx',
      formats: ['cjs'],
      name: 'dshRouterClient',
      fileName: () => CLIENT_FILE,
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis'],
      output: {
        entryFileNames: CLIENT_FILE,
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
        footer: `return module.exports; } });`,
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    },
    target: 'es2020',
    minify: false,
    sourcemap: true,
  },
  logLevel: 'warn',
})
