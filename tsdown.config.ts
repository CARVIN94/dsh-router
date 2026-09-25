/**
 * tsdown build for dsh-router — HOST half only.
 *
 * Produces `lib/index.js`: the Node host half (ESM) that serves
 * /router/api/* on the DSH webServer.
 *
 * The BROWSER client half (React panel + sidebar entry) is built separately
 * by Vite — see `client/vite.config.ts`, which emits `lib/client.js`
 * (profile channel, id `dsh-router-core` — the npm package name, so it
 * matches the cordis.patch.yml row's `name`) and `lib/client-registry.js`
 * (registry channel, id `dsh-external/dsh-router`).
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
      // 内置供应商的**行**（cordis 壳）：产物落在 lib/suppliers/<x>/index.js，
      // 配合 package.json exports 的 `./suppliers/<x>` 子路径被 loader import。
      // 供应商实现（plugin.ts）被这一层内联进来，所以每个子路径只有这一个 js。
      // 之前这里是 `suppliers/<x>` → plugin.ts，由核心**扫目录**加载（loadSuppliers）；
      // 改成行之后那条扫描路径已删除，见 loader.ts。
      'suppliers/opencode/index': 'src/suppliers/opencode/index.ts',
      'suppliers/openrouter/index': 'src/suppliers/openrouter/index.ts',
      'suppliers/nvidia/index': 'src/suppliers/nvidia/index.ts',
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
