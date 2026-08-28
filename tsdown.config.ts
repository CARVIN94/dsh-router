/**
 * tsdown build for dsh-router — HOST half only.
 *
 * Produces `lib/index.js`: the Node host half (ESM) that serves
 * /router/api/* on the DSH webServer.
 *
 * The BROWSER client half (React panel + sidebar entry) is built separately
 * by Vite — see `client/vite.config.ts`, which emits `lib/client.js`
 * (profile channel, id `dsh-router`) and `lib/client-registry.js` (registry
 * channel, id `dsh-external/dsh-router`).
 */
import { builtinModules, createRequire } from 'node:module'
import type { UserConfig } from 'tsdown'

const require = createRequire(import.meta.url)

/** Node builtins must never survive into the browser module-loader factory. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => `node:${id}`),
])

export default [
  {
    entry: {
      index: 'src/index.ts',
      // opencode free：参考 9Router 实现的无鉴权免费供应商
      'suppliers/opencode': 'src/suppliers/opencode/plugin.ts',
      // openrouter：参考 9Router 实现的 apikey 免费供应商（OPENROUTER_API_KEY）
      'suppliers/openrouter': 'src/suppliers/openrouter/plugin.ts',
      // nvidia：参考 9Router 实现的 apikey 供应商（NVIDIA NIM）
      'suppliers/nvidia': 'src/suppliers/nvidia/plugin.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // @deepseek-ai/* are peer deps provided by the DSH host (see package.json
    // peerDependencies): keep them as runtime imports, never bundle.
    deps: {
      neverBundle: [/^@deepseek-ai\//],
    },
  },
] satisfies UserConfig[]
