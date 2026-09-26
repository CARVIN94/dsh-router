/**
 * 供应商插件的**契约体检**：逐个成员报告「实现了吗 / 实跑通了吗 / 为什么没跑」。
 *
 * 为什么不直接在客户端遍历：契约成员活在**宿主进程**里的模块实例上
 * （`wrapModule` 把它挂在 `supplier.__module`），客户端只看得见 `/health` 摘要里
 * 那 5 个能力名 —— 那是 `DIFF_CAPS`，不是契约全貌。所以探测必须在核心里做。
 *
 * ## 最重要的约束：绝不代替用户做有副作用的事
 *
 * 「把所有功能跑一遍」听起来很爽，但契约里有一半成员**不能自动调**：
 * `dispose` 调了就是卸载供应商；`removeLink`/`addApiKey` 动凭证；
 * `generateLoginUrl` 很可能直接触发设备码/OAuth 流；`checkinNow` 是替用户签到。
 * 这些**只报「已实现」并说明为什么不自动执行**。体检是给眼睛看的，不是给手用的。
 *
 * `tests/probe.test.ts` 里有一条判据专门锁这件事：被标记为 `skip` 的成员，
 * 探针一个都不会去调（用会记账的假模块验）。
 *
 * ## 清单要跟契约一起长
 *
 * 契约加了成员而这里没加 = 体检漏检。所以 `probe.test.ts` 直接解析
 * `contract.ts` 源码里的 `SupplierModule` 成员名，断言清单全覆盖 —— 编译期类型
 * 抓不到这种「两份清单」，只能这样钉。
 */
import type { SupplierModule } from './contract.ts'
import type { LoadedSupplier } from './loader.ts'

/** 探针会不会自动执行。`skip` = 有副作用或无法凭空调用，只报存在性。 */
export type ProbeKind = 'safe' | 'skip'

/** 一个契约成员的体检条目。 */
export interface ProbeMember {
  /** 契约里的成员名（与 `SupplierModule` 逐字一致）。 */
  key: string
  /** 面板显示名。 */
  label: string
  /** 必填成员 / 可选（差异化）成员。 */
  required: boolean
  probe: ProbeKind
  /** 不自动执行的原因（`probe: 'skip'` 时必填，面板要显示给用户看）。 */
  skipReason?: string
}

/** 结果里一条成员的最终状态。 */
export type ProbeState = 'ok' | 'fail' | 'absent' | 'skipped'

export interface ProbeResult {
  key: string
  label: string
  required: boolean
  present: boolean
  probe: ProbeKind
  state: ProbeState
  /** 摘要/失败原因。 */
  detail?: string
}

export interface ProbeReport {
  supplier: string
  name: string
  members: ProbeResult[]
  summary: { total: number; implemented: number; ok: number; fail: number; absent: number; skipped: number }
}

/**
 * 契约成员清单（体检的唯一事实来源）。
 *
 * `required: false` = 差异化能力，按存在性暴露端点/UI；`probe: 'skip'` 的理由都写在这里，
 * 面板会把 `skipReason` 原样显示 —— 用户能知道「有这个能力，只是体检不替你调」。
 */
export const SUPPLIER_CONTRACT_MEMBERS: readonly ProbeMember[] = [
  { key: 'id', label: '供应商 id', required: true, probe: 'safe' },
  { key: 'name', label: '显示名', required: true, probe: 'safe' },
  { key: 'priority', label: '优先级', required: false, probe: 'safe' },
  { key: 'icon', label: '图标', required: false, probe: 'safe' },
  { key: 'apiKeyHint', label: 'API key 提示文案', required: false, probe: 'safe' },

  { key: 'status', label: '账号状态', required: true, probe: 'safe' },
  { key: 'listModels', label: '模型列表', required: true, probe: 'safe' },
  {
    key: 'chatOnce',
    label: '调用上游',
    required: true,
    probe: 'skip',
    skipReason: '会真的发一次请求（消耗额度）。用上面的「跑一次访问测试」单独测，或在供应商详情里测模型。',
  },
  {
    key: 'dispose',
    label: '卸载清理',
    required: true,
    probe: 'skip',
    skipReason: '调用它就是把这个供应商卸载掉。',
  },

  {
    key: 'generateLoginUrl',
    label: '生成登录链接',
    required: false,
    probe: 'skip',
    skipReason: '可能直接触发设备码 / OAuth 登录流。',
  },
  {
    key: 'completeLogin',
    label: '完成登录回调',
    required: false,
    probe: 'skip',
    skipReason: '需要一个真实的回调 URL 才能调，空调没有意义。',
  },
  {
    key: 'addApiKey',
    label: '添加 API key',
    required: false,
    probe: 'skip',
    skipReason: '会写进凭证库。',
  },
  {
    key: 'removeLink',
    label: '删除连接',
    required: false,
    probe: 'skip',
    skipReason: '会删掉这个连接的凭证。',
  },
  { key: 'pollLogin', label: '轮询式登录', required: false, probe: 'safe' },
  {
    key: 'checkinNow',
    label: '签到',
    required: false,
    probe: 'skip',
    skipReason: '会替这个连接真的去签到。',
  },
] as const

/** 读原始模块实例（`wrapModule` 挂在 wrapper 上）。 */
function rawModule(loaded: LoadedSupplier): Record<string, unknown> {
  return (loaded.supplier as unknown as { __module?: Record<string, unknown> }).__module ?? {}
}

/** 取一个账号 uid 供只读探测用（没有账号的供应商返回空串）。 */
function someAccountUid(status: unknown): string {
  if (typeof status !== 'object' || status === null) return ''
  const accounts = (status as { accounts?: unknown }).accounts
  if (!Array.isArray(accounts) || accounts.length === 0) return ''
  const first = accounts[0]
  return typeof (first as { uid?: unknown })?.uid === 'string' ? (first as { uid: string }).uid : ''
}

/** 摘要：把返回值压成一行可读文本。 */
function describe(value: unknown): string {
  if (value === undefined) return '返回 undefined'
  if (value === null) return '返回 null'
  if (Array.isArray(value)) return `返回 ${value.length} 项`
  if (typeof value === 'string') return value === '' ? '返回空串' : `返回 ${value.slice(0, 40)}`
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.ok === 'boolean') return o.ok === false ? `ok:false ${String(o.error ?? o.message ?? '')}`.trim() : 'ok:true'
    return `${Object.keys(o).slice(0, 4).join(', ') || '空对象'}`
  }
  return `返回 ${typeof value}`
}

/** 异步取一个值并压成摘要（同步抛错也要接住）。 */
async function probeValue(call: () => unknown): Promise<{ ok: boolean; detail: string }> {
  try {
    const value = await call()
    return { ok: true, detail: describe(value) }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}

/**
 * 体检一个已装载的供应商。
 *
 * 只跑 `probe: 'safe'` 的成员；`skip` 的只报存在性。绝不代替用户调有副作用的成员。
 */
export async function probeSupplier(loaded: LoadedSupplier): Promise<ProbeReport> {
  const m = rawModule(loaded)
  const members: ProbeResult[] = []
  for (const member of SUPPLIER_CONTRACT_MEMBERS) {
    const present = member.key in m ? m[member.key] !== undefined : false
    const base = { key: member.key, label: member.label, required: member.required, present, probe: member.probe }
    if (!present) {
      members.push({ ...base, state: member.required ? 'fail' : 'absent', ...(member.required ? { detail: '必填成员缺失，插件不完整' } : {}) })
      continue
    }
    if (member.probe === 'skip') {
      members.push({ ...base, state: 'skipped', ...(member.skipReason === undefined ? {} : { detail: member.skipReason }) })
      continue
    }
    const outcome = await runSafeProbe(member.key, m as unknown as SupplierModule)
    members.push({ ...base, state: outcome.ok ? 'ok' : 'fail', detail: outcome.detail })
  }
  const summary = {
    total: members.length,
    implemented: members.filter((x) => x.present).length,
    ok: members.filter((x) => x.state === 'ok').length,
    fail: members.filter((x) => x.state === 'fail').length,
    absent: members.filter((x) => x.state === 'absent').length,
    skipped: members.filter((x) => x.state === 'skipped').length,
  }
  return { supplier: loaded.supplier.id, name: loaded.supplier.name, members, summary }
}

/** 只读成员的实跑。**每个 case 都必须没有副作用** —— 新增成员时照此办理。 */
async function runSafeProbe(key: string, m: SupplierModule): Promise<{ ok: boolean; detail: string }> {
  switch (key) {
    case 'id':
    case 'name':
    case 'priority':
    case 'icon':
    case 'apiKeyHint': {
      // 纯字段：存在即通过，取值只为了在面板上回显
      const value = (m as unknown as Record<string, unknown>)[key]
      if (value === undefined) return { ok: true, detail: '未提供（可选）' }
      return { ok: true, detail: describe(value) }
    }
    case 'status': {
      const r = await probeValue(() => m.status())
      if (!r.ok) return r
      const uid = someAccountUid(m.status())
      return { ok: true, detail: `${r.detail}，账号 ${uid === '' ? 0 : '≥1'}` }
    }
    case 'listModels': {
      return await probeValue(() => m.listModels())
    }
    case 'pollLogin': {
      return await probeValue(() => m.pollLogin?.())
    }
    default:
      // 清单里出现了没写 case 的成员：当成「不探」，别蒙混过关
      return { ok: true, detail: '未纳入自动探测' }
  }
}
