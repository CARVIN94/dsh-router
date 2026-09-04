/**
 * 通用供应商配置 —— dsh-router 核心能力,按供应商 id 存储。
 *
 * 通用能力(所有供应商共享,供应商 js 不需要实现)：
 *   - 别名 alias(前缀,模型全名 = alias/id)
 *   - 模型管理:启用/禁用 disabled、自定义 custom
 *   - 连接池:poolOrder(拖动排序)、poolStrategy(回退/轮询)
 *   - 积分缓存 credits:按 supplier/uid 缓存最后一次拿到的剩余额度
 *
 * 持久化到 data/supplier-config.json。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type PoolStrategy = 'fallback' | 'round-robin'

/**
 * 积分哨兵:插件还**没拿到过**真实额度(刚重启、积分拉取失败、或压根不支持
 * 积分)时报 `-1`,核心据此保留上一次的缓存值,而不是把 0 写进去。
 *
 * 为什么不能用 0 表示未知:积分 0 是有意义的真值(用完了),核心无法区分
 * 「拿到 0」和「没拿到」。用 0 当哨兵会把缓存冲成 0 —— 这正是 codebuddy
 * 重启后面板永久显示 0 积分的原因(插件只在内存里缓存积分)。
 */
export const CREDITS_UNKNOWN = -1

export interface SupplierConfig {
  alias: string
  disabled: string[]
  custom: string[]
  poolOrder: string[]
  poolStrategy: PoolStrategy
  /** 积分缓存:uid → 剩余额度(最后一次从插件拿到的非 -1 值)。 */
  credits: Record<string, number>
  /** 每连接显示别名:uid → 显示名(空/缺省用供应商原始昵称,纯展示不改路由键)。 */
  accountNames: Record<string, string>
}

interface ConfigFile {
  suppliers: Record<string, Partial<SupplierConfig>>
}

/** 读盘时的积分字段校验：只留有限非负数（负数一律当没缓存过）。 */
function readCredits(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [uid, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[uid] = v
  }
  return out
}

/** 读盘时的连接显示别名校验：只留非空字符串。 */
function readNames(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [uid, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim() !== '') out[uid] = v.trim()
  }
  return out
}

/** 通用供应商配置存储。 */
export class SupplierConfigStore {
  private fp = ''
  private bySupplier = new Map<string, SupplierConfig>()
  /** 全部供应商 id（加载时同步），用于别名唯一性校验。 */
  private knownIds = new Set<string>()

  constructor(stateFile: string) {
    this.fp = stateFile ? join(dirname(stateFile), 'supplier-config.json') : ''
    this.load()
  }

  /** 同步已知供应商 id 集合（加载供应商后调用）。 */
  sync(supplierIds: string[]): void {
    this.knownIds = new Set(supplierIds)
  }

  /** 各供应商当前生效的别名（未设置别名的用供应商 id）。 */
  effectiveAliases(): Map<string, string> {
    const out = new Map<string, string>()
    for (const id of this.knownIds) {
      out.set(id, this.bySupplier.get(id)?.alias || id)
    }
    return out
  }

  /** 读取某供应商配置(不存在则返回默认并注册)。 */
  get(supplierId: string): SupplierConfig {
    let cfg = this.bySupplier.get(supplierId)
    if (!cfg) {
      cfg = { alias: '', disabled: [], custom: [], poolOrder: [], poolStrategy: 'fallback', credits: {}, accountNames: {} }
      this.bySupplier.set(supplierId, cfg)
    }
    return cfg
  }

  /**
   * 设置别名。别名必须唯一——它是对外模型全名的前缀（alias/model），
   * 请求时用别名反查供应商，重复就会指错人。空别名表示用供应商 id（默认值）。
   * @returns 冲突时返回占用的供应商 id
   */
  setAlias(supplierId: string, alias: string): { ok: boolean; conflictWith?: string } {
    const clean = alias.trim()
    // 空 = 用默认（供应商 id）；此时要确认没有别人显式占用了本供应商的 id 作别名
    const effective = clean === '' ? supplierId : clean
    for (const [id, cur] of this.effectiveAliases()) {
      if (id !== supplierId && cur === effective) return { ok: false, conflictWith: id }
    }
    this.get(supplierId).alias = clean
    this.saveLocked()
    return { ok: true }
  }

  setModelEnabled(supplierId: string, modelId: string, enabled: boolean): void {
    const cfg = this.get(supplierId)
    cfg.disabled = enabled
      ? cfg.disabled.filter((m) => m !== modelId)
      : [...new Set([...cfg.disabled, modelId])]
    this.saveLocked()
  }

  setAllModelsEnabled(supplierId: string, enabled: boolean, allModelIds: string[]): void {
    const cfg = this.get(supplierId)
    cfg.disabled = enabled ? [] : [...new Set(allModelIds)]
    this.saveLocked()
  }

  addCustomModel(supplierId: string, modelId: string): void {
    const cfg = this.get(supplierId)
    if (!cfg.custom.includes(modelId)) cfg.custom.push(modelId)
    this.saveLocked()
  }

  removeCustomModel(supplierId: string, modelId: string): void {
    const cfg = this.get(supplierId)
    cfg.custom = cfg.custom.filter((m) => m !== modelId)
    cfg.disabled = cfg.disabled.filter((m) => m !== modelId)
    this.saveLocked()
  }

  setPoolOrder(supplierId: string, uids: string[]): void {
    this.get(supplierId).poolOrder = [...new Set(uids)]
    this.saveLocked()
  }

  setPoolStrategy(supplierId: string, strategy: string): void {
    if (strategy !== 'fallback' && strategy !== 'round-robin') return
    this.get(supplierId).poolStrategy = strategy
    this.saveLocked()
  }

  // ---- 每连接显示别名（连接池改名，纯展示；uid 仍是路由/匹配键） ----

  /** 读某连接的显示别名;没设或为空返回 `undefined`(用供应商原始昵称)。 */
  getAccountName(supplierId: string, uid: string): string | undefined {
    const n = this.get(supplierId).accountNames[uid]
    return typeof n === 'string' && n !== '' ? n : undefined
  }

  /** 设置连接显示名。空名 = 删除别名(回到供应商原始昵称)。 */
  setAccountName(supplierId: string, uid: string, name: string): void {
    const cfg = this.get(supplierId)
    const clean = (name ?? '').trim()
    if (clean === '') {
      if (cfg.accountNames[uid] === undefined) return
      delete cfg.accountNames[uid]
      this.saveLocked()
      return
    }
    cfg.accountNames[uid] = clean
    this.saveLocked()
  }

  // ---- 积分缓存（核心统一持久化，插件只管报） ----

  /**
   * 读缓存的积分。没缓存过返回 `CREDITS_UNKNOWN`(-1),让调用方自己决定
   * 显示什么——不要把 -1 当 0 展示。
   */
  getCredits(supplierId: string, uid: string): number {
    const v = this.get(supplierId).credits[uid]
    return typeof v === 'number' && Number.isFinite(v) ? v : CREDITS_UNKNOWN
  }

  /**
   * 合并插件报的积分:非 -1 就写入并返回它;-1(未知)则回落到上次缓存值。
   * @returns 面板该显示的积分(仍可能是 -1 = 从来没拿到过)
   */
  putCredits(supplierId: string, uid: string, reported: number): number {
    if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) {
      return this.getCredits(supplierId, uid)
    }
    const prev = this.getCredits(supplierId, uid)
    if (prev === reported) return reported // 值没变,不写盘(status() 是高频调用)
    this.get(supplierId).credits[uid] = reported
    this.saveLocked()
    return reported
  }

  /** 删除链接时清掉它的积分缓存(不写盘:下一行 removeLink 会带出保存)。 */
  clearCredits(supplierId: string, uid: string): void {
    const credits = this.get(supplierId).credits
    if (credits[uid] === undefined) return
    delete credits[uid]
    this.saveLocked()
  }

  private load(): void {
    if (this.fp === '') return
    let f: ConfigFile
    try {
      f = JSON.parse(readFileSync(this.fp, 'utf8')) as ConfigFile
    } catch {
      return
    }
    for (const [id, c] of Object.entries(f.suppliers ?? {})) {
      this.bySupplier.set(id, {
        alias: typeof c.alias === 'string' ? c.alias : '',
        disabled: Array.isArray(c.disabled) ? c.disabled.filter((m) => typeof m === 'string') : [],
        custom: Array.isArray(c.custom) ? c.custom.filter((m) => typeof m === 'string') : [],
        poolOrder: Array.isArray(c.poolOrder) ? c.poolOrder.filter((u) => typeof u === 'string') : [],
        poolStrategy: c.poolStrategy === 'round-robin' ? 'round-robin' : 'fallback',
        credits: readCredits(c.credits),
        accountNames: readNames(c.accountNames),
      })
    }
  }

  private saveLocked(): void {
    if (this.fp === '') return
    const f: ConfigFile = { suppliers: {} }
    for (const [id, cfg] of this.bySupplier) {
      f.suppliers[id] = {
        alias: cfg.alias,
        disabled: [...cfg.disabled],
        custom: [...cfg.custom],
        poolOrder: [...cfg.poolOrder],
        poolStrategy: cfg.poolStrategy,
        credits: { ...cfg.credits },
        accountNames: { ...cfg.accountNames },
      }
    }
    try {
      const dir = dirname(this.fp)
      if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true })
      const raw = JSON.stringify(f, null, 2)
      const tmp = this.fp + '.tmp'
      writeFileSync(tmp, raw, { mode: 0o600 })
      renameSync(tmp, this.fp)
    } catch {
      // 持久化失败不阻断运行
    }
  }
}
