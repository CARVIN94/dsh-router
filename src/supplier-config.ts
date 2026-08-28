/**
 * 通用供应商配置 —— dsh-router 核心能力,按供应商 id 存储。
 *
 * 通用能力(所有供应商共享,供应商 js 不需要实现)：
 *   - 别名 alias(前缀,模型全名 = alias/id)
 *   - 模型管理:启用/禁用 disabled、自定义 custom
 *   - 连接池:poolOrder(拖动排序)、poolStrategy(回退/轮询)
 *   - 签到规则 checkinRule(所有链接 / 首个链接)
 *
 * 持久化到 data/supplier-config.json。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type PoolStrategy = 'fallback' | 'round-robin'
export type CheckinRule = 'all' | 'first'

export interface SupplierConfig {
  alias: string
  disabled: string[]
  custom: string[]
  poolOrder: string[]
  poolStrategy: PoolStrategy
  checkinRule: CheckinRule
}

interface ConfigFile {
  suppliers: Record<string, Partial<SupplierConfig>>
}

/** 通用供应商配置存储。 */
export class SupplierConfigStore {
  private fp = ''
  private bySupplier = new Map<string, SupplierConfig>()

  constructor(stateFile: string) {
    this.fp = stateFile ? join(dirname(stateFile), 'supplier-config.json') : ''
    this.load()
  }

  /** 读取某供应商配置(不存在则返回默认并注册)。 */
  get(supplierId: string): SupplierConfig {
    let cfg = this.bySupplier.get(supplierId)
    if (!cfg) {
      cfg = { alias: '', disabled: [], custom: [], poolOrder: [], poolStrategy: 'fallback', checkinRule: 'all' }
      this.bySupplier.set(supplierId, cfg)
    }
    return cfg
  }

  setAlias(supplierId: string, alias: string): void {
    this.get(supplierId).alias = alias
    this.saveLocked()
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

  setCheckinRule(supplierId: string, rule: string): void {
    if (rule !== 'all' && rule !== 'first') return
    this.get(supplierId).checkinRule = rule
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
        checkinRule: c.checkinRule === 'first' ? 'first' : 'all',
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
        checkinRule: cfg.checkinRule,
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
