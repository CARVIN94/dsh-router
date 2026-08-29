/**
 * 供应商 loader —— 扫描 suppliers 目录下的 *.js，动态 import，按契约包装成
 * 内部 Supplier，并暴露"能力检测"(capabilities)供通用路由/前端按能力渲染。
 *
 * 加载来源（两处，profile 优先）：
 *   1. 内置：<plugin>/lib/suppliers/*.js（随插件分发）
 *   2. 用户：~/.dsh/profiles/web/suppliers/*.js（用户自定义）
 */
import { readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ServerResponse } from 'node:http'
import type { ChatRequest, ModelInfo, ModelWithEnabled, Supplier, SupplierStatus } from '../router/types.ts'
import type { SupplierConfigStore } from '../supplier-config.ts'
import type { CredentialStore } from '../credential-store.ts'
import type { ChatOnceResult, SupplierAccountNow, SupplierEnv, SupplierFactory, SupplierModule } from './contract.ts'
import { AccountPool } from '../router/account-pool.ts'

/** 供应商加载错误（不阻断其他供应商）。 */
export interface SupplierLoadError {
  id: string
  file: string
  error: string
}

/** 供应商实例 + 能力标记。 */
export interface LoadedSupplier {
  supplier: Supplier
  /** 差异化能力集合（方法名存在性，通用能力不在此列）。 */
  capabilities: Set<string>
  /** 来源：内置 / 用户目录 / 外部插件（cordis service）。 */
  source: 'builtin' | 'user' | 'external'
}

function isFn(v: unknown): v is (...args: unknown[]) => unknown {
  return typeof v === 'function'
}

/** 从模块导出解析出供应商模块对象（支持 export default / 命名导出 / factory）。 */
function resolveModule(mod: Record<string, unknown>, file: string): SupplierModule {
  const cand = (mod.default ?? mod) as Record<string, unknown>
  // factory 形式：模块 default 是 (env) => SupplierModule，跳过静态检查，loadOne 调用后实例生效
  if (typeof cand === 'function') return cand as unknown as SupplierModule
  if (typeof cand !== 'object' || cand === null) throw new Error(`供应商模块无效: ${file}`)
  if (typeof cand.id !== 'string' || cand.id === '') throw new Error(`供应商缺少 id: ${file}`)
  if (typeof cand.name !== 'string' || cand.name === '') throw new Error(`供应商缺少 name: ${file}`)
  return cand as unknown as SupplierModule
}

/** 加载单个供应商文件，返回模块对象或抛错。 */
async function importSupplierFile(file: string): Promise<SupplierModule> {
  const url = pathToFileURL(file).href
  const mod = (await import(url)) as Record<string, unknown>
  return resolveModule(mod, file)
}

/**
 * 差异化能力（供应商 js 实现；其余为通用能力由核心提供）。
 * testModel / 连接池 / 模型管理 / 别名 / 凭证存储均为核心通用能力，不在此列。
 */
const DIFF_CAPS = [
  'generateLoginUrl', 'completeLogin',
  'addApiKey',
  'pollLogin',
  'checkinNow',
] as const

/** 从文件构造 LoadedSupplier。 */
async function loadOne(file: string, env: SupplierEnv, source: 'builtin' | 'user'): Promise<LoadedSupplier> {
  const mod = await importSupplierFile(file)
  // 支持 factory: 模块本身就是工厂函数
  let instance: SupplierModule
  if (typeof mod === 'function') {
    instance = (mod as unknown as SupplierFactory)(env)
    if (typeof instance !== 'object' || instance === null || typeof instance.id !== 'string' || instance.id === '') {
      throw new Error(`供应商 factory 返回无效: ${file}`)
    }
    // 测试模型由核心统一走 chatOnce 路径，插件无需实现 testModel
  } else {
    instance = mod
  }
  return wrapModule(instance, env, file, source)
}

/**
 * 从 SupplierModule 实例构造 LoadedSupplier（能力检测 + Supplier 包装）。
 * 文件加载（loadOne）与外部插件供应商（cordis service）共用。
 */
export function wrapModule(instance: SupplierModule, env: SupplierEnv, source: string, kind: 'builtin' | 'user' | 'external' = 'external'): LoadedSupplier {
  if (typeof instance !== 'object' || instance === null || typeof instance.id !== 'string' || instance.id === '') {
    throw new Error(`供应商模块无效: ${source}`)
  }
  // 测试模型由核心统一走 chatOnce 路径（账号池回退/冷却自动生效），插件无需实现 testModel
  const capabilities = new Set<string>()
  for (const key of DIFF_CAPS) {
    if (isFn((instance as unknown as Record<string, unknown>)[key])) capabilities.add(key)
  }

  // 账号池由核心持有（选号/冷却/禁用/错误累计），插件不参与。
  // 挂在 supplier 上：status() 叠加状态与 Router 的 chat 循环共用同一实例。
  const pool = new AccountPool()

  const supplier: Supplier = {
    id: instance.id,
    name: instance.name,
    priority: instance.priority ?? 0,
    icon: (instance as { icon?: string }).icon,
    status: (): SupplierStatus => {
      const now = instance.status()
      return { id: now.id, name: now.name, accounts: pool.decorate(now.accounts) }
    },
    listModels: (force?: boolean): Promise<ModelInfo[]> | ModelInfo[] => instance.listModels(force),
    // 通用能力：模型启用状态/自定义由核心 SupplierConfigStore 合并
    modelsWithEnabled: (force?: boolean): Promise<ModelWithEnabled[]> | ModelWithEnabled[] => {
      const cfg = env.store.get(instance.id)
      const disabled = new Set(cfg.disabled)
      const custom = new Set(cfg.custom)
      return Promise.resolve(instance.listModels(force)).then((list) =>
        list.map((mm) => ({
          ...mm,
          enabled: !disabled.has(mm.id),
          custom: custom.has(mm.id) ? true : undefined,
        })),
      )
    },
    getAlias: (): string => env.store.get(instance.id).alias || instance.getAlias(),
    customModelIds: (): string[] => [...env.store.get(instance.id).custom],
    accounts: (): SupplierAccountNow[] => instance.status().accounts,
    chatOnce: (uid: string, req: ChatRequest): Promise<ChatOnceResult> => instance.chatOnce(uid, req),
    lastError: isFn((instance as unknown as Record<string, unknown>).lastError)
      ? (): string | undefined => (instance as unknown as { lastError(): string | undefined }).lastError()
      : undefined,
    // 删除链接：数据删除是通用能力，凭证清理由供应商内部实现（js 契约不要求）
    removeLink: isFn((instance as unknown as Record<string, unknown>).removeLink)
      ? (uid: string): Promise<boolean> => (instance as unknown as { removeLink(uid: string): Promise<boolean> }).removeLink(uid)
      : undefined,
    dispose: (): void => instance.dispose(),
    pool,
  }
  // 差异化路由通过 LoadedSupplier.capabilities + supplier 实例调用面板方法
  ;(supplier as Supplier & { __module?: SupplierModule }).__module = instance

  return { supplier, capabilities, source: kind }
}

/** 扫描目录下所有 *.js（一层）。 */
function scanDir(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

export interface LoadSuppliersOptions {
  /** 内置供应商目录（<plugin>/lib/suppliers）。 */
  builtinDir: string
  /** 用户供应商目录（~/.dsh/profiles/web/suppliers）。 */
  userDir: string
  /** 数据目录。 */
  dataDir: string
  /** 通用配置存储。 */
  store: SupplierConfigStore
  /** 通用凭证存储。 */
  credentials: CredentialStore
  log: (msg: string) => void
}

/** 加载全部供应商（内置 + 用户，用户覆盖内置同 id）。 */
export async function loadSuppliers(opts: LoadSuppliersOptions): Promise<{
  suppliers: LoadedSupplier[]
  errors: SupplierLoadError[]
}> {
  const env: SupplierEnv = { dataDir: opts.dataDir, log: opts.log, store: opts.store, credentials: opts.credentials }
  const byId = new Map<string, LoadedSupplier>()
  const errors: SupplierLoadError[] = []

  const files = [
    ...scanDir(opts.builtinDir).map((f) => ({ f, builtin: true })),
    ...scanDir(opts.userDir).map((f) => ({ f, builtin: false })),
  ]
  for (const { f, builtin } of files) {
    try {
      const loaded = await loadOne(f, env, builtin ? 'builtin' : 'user')
      // 用户目录覆盖内置
      const existing = byId.get(loaded.supplier.id)
      if (existing && builtin) continue // 内置已被用户版覆盖
      byId.set(loaded.supplier.id, loaded)
      opts.log(`supplier ${loaded.supplier.id} loaded (${builtin ? 'builtin' : 'user'}) from ${basename(f)}`)
    } catch (err) {
      errors.push({ id: basename(f, '.js'), file: f, error: (err as Error).message })
      opts.log(`supplier load failed ${basename(f)}: ${(err as Error).message}`)
    }
  }
  return { suppliers: [...byId.values()], errors }
}
