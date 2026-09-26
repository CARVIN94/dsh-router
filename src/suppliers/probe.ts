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

/**
 * 体检档位。
 *
 * - `read-only`（默认）：只跑没有副作用的成员。日常排查用这个，随便点。
 * - `full`（出厂体检）：额外用**无害的探针输入**实跑那些「有副作用但可以不碰真实
 *   状态就跑通代码路径」的成员 —— 例如 `removeLink` 传一个不存在的 uid、
 *   `completeLogin` 传一个明显无效的回调 URL。出厂前要问的是「每个功能到底通不通」，
 *   只报存在性回答不了这个问题。
 *
 * 即便在 `full` 档，仍有成员**永不实跑**（见 `NEVER_RUN`）：那些不是「用探针输入就能
 * 安全试」的，而是任何输入都会改动真实状态。
 */
export type ProbeMode = 'read-only' | 'full'

/** 探针会不会自动执行。`skip` = 只报存在性。 */
export type ProbeKind = 'safe' | 'skip'

/**
 * 这个成员**到底跑没跑**。`no` 时 `detail` 必须写清为什么 —— 体检报告的价值全在
 * 「哪些是验过的、哪些只是看了一眼」。
 */
export type ProbeExecuted = 'ran' | 'probed' | 'no'

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
  /** 到底跑没跑：实跑 / 用探针输入实跑 / 没跑。 */
  executed: ProbeExecuted
  /** 摘要/失败原因；`executed: 'no'` 时这里是「为什么没跑」。 */
  detail?: string
}

/** 出厂结论。 */
export type ProbeVerdict = 'pass' | 'warn' | 'fail'


/**
 * **核心侧**能力：不属于插件契约（插件不实现它们，是核心代劳），所以不在上面的
 * 成员表里 —— 但体检要看它们的状态。模型启用/禁用就是这一类。
 */
export interface ProbeCoreReport {
  models: {
    /** 模型总数；`listModels` 失败时为 null（= 拿不到，不代表 0 个）。 */
    total: number | null
    enabled: number
    disabled: number
    /** 拿不到总数时的原因。 */
    note?: string
  }
  /** 核心代劳的操作：**只报可用性，一律不自动执行**（改了就是替用户改配置）。 */
  operations: Array<{ key: string; label: string; available: boolean; detail?: string }>
}

export interface ProbeReport {
  supplier: string
  name: string
  mode: ProbeMode
  /** 出厂结论：`fail` = 必填成员缺失/实跑失败；`warn` = 可选能力缺或没实跑；`pass` = 全绿。 */
  verdict: ProbeVerdict
  members: ProbeResult[]
  core: ProbeCoreReport
  summary: {
    total: number
    implemented: number
    ok: number
    fail: number
    absent: number
    skipped: number
    /** 实际实跑过的成员数（`executed !== 'no'`）。 */
    ran: number
  }
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

/** 读出账号状态列表（只读，不改任何东西）。 */
function accountStates(status: unknown): Array<{ uid: string; state: string; cooling: boolean }> {
  if (typeof status !== 'object' || status === null) return []
  const accounts = (status as { accounts?: unknown }).accounts
  if (!Array.isArray(accounts)) return []
  return accounts.flatMap((a) => {
    const uid = (a as { uid?: unknown })?.uid
    if (typeof uid !== 'string') return []
    const state = typeof (a as { state?: unknown }).state === 'string' ? (a as { state: string }).state : 'ok'
    return [{ uid, state, cooling: (a as { cooling?: unknown }).cooling === true }]
  })
}

/** 账号状态分布：`正常 2、冷却 1`、`session_dead 1` 这样。 */
function accountTally(accounts: Array<{ uid: string; state: string; cooling: boolean }>): string {
  const counts = new Map<string, number>()
  for (const a of accounts) {
    const key = a.cooling ? '冷却' : a.state === 'ok' ? '正常' : a.state
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([k, n]) => `${k} ${n}`).join('、')
}

/**
 * 摘要：把返回值压成一行**对排查有用**的文本。
 *
 * 原先只说「返回 number」「返回 data:image/svg+xml,%3Csvg…」——等于没说话：
 * 体检的意义就是让人一眼看出「priority 是几」「图标给了没有」。
 */
function describe(value: unknown): string {
  if (value === undefined) return '未提供（可选）'
  if (value === null) return '返回 null'
  if (Array.isArray(value)) return `${value.length} 项`
  if (typeof value === 'string') {
    // 内联图标是一整段 data URI，截断出来全是 %3C…，不如说清「给了、是什么格式」
    if (value.startsWith('data:')) return `已提供（内联 ${value.slice(5, value.indexOf('/') || 12)}）`
    if (value === '') return '返回空串'
    return value.length > 48 ? `返回 ${value.slice(0, 48)}…` : `返回 ${value}`
  }
  if (typeof value === 'number' || typeof value === 'boolean') return `返回 ${value}`
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.ok === 'boolean') return o.ok === false ? `ok:false ${String(o.error ?? o.message ?? '')}`.trim() : 'ok:true'
    return Object.keys(o).slice(0, 4).join(', ') || '空对象'
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
 * 深度档下**仍然永不实跑**的成员，以及原因。
 *
 * 判据是「**任何输入都会改动真实状态**」——`probe: 'skip'` 里那些能靠无害探针输入
 * 试的（removeLink 传不存在的 uid、completeLogin 传无效回调）不在此列。
 * `dispose` 调用它就是把这个供应商卸载掉，连「试一下」都不成立。
 */
const NEVER_RUN: Record<string, string> = {
  dispose: '调用它就是把这个供应商卸载掉 —— 连「试一下」都不成立。',
  addApiKey: '任何输入都会写进凭证库，没有无害的探针输入。',
  checkinNow: '会替这个连接真的去签到，签到额度用掉就没了。',
  chatOnce: '会真发一次请求（消耗额度）。用「跑一次访问测试」单独测。',
}

/** 深度档用来「不碰真实状态就跑通代码路径」的探针输入。 */
const PROBE_UID = '__probe_no_such_uid__'
const PROBE_CALLBACK = 'https://invalid.example/__probe__'

/** 该成员在当前档位下怎么执行；`undefined` = 本档不跑。 */
function execution(key: string, present: boolean, probe: ProbeKind, mode: ProbeMode): { executed: ProbeExecuted; detail?: string } {
  if (!present) return { executed: 'no' }
  if (probe === 'safe') return { executed: 'ran' }
  const never = NEVER_RUN[key]
  if (never !== undefined) return { executed: 'no', detail: never }
  if (mode === 'read-only') return { executed: 'no' }
  return { executed: 'probed' }
}

/**
 * 体检一个已装载的供应商。
 *
 * 只跑 `probe: 'safe'` 的成员；`skip` 的只报存在性。绝不代替用户调有副作用的成员。
 *
 * @param models - 该供应商当前的模型启用状态（由调用方用 `router.modelsOf` 取，
 *   走核心缓存不额外打上游）。取不到就传 undefined —— 报告里会如实写「拿不到」，
 *   不能拿 0 冒充「一个模型都没有」。
 */
export async function probeSupplier(
  loaded: LoadedSupplier,
  models?: ReadonlyArray<{ id: string; enabled: boolean }>,
  mode: ProbeMode = 'read-only',
): Promise<ProbeReport> {
  const m = rawModule(loaded)
  const members: ProbeResult[] = []
  for (const member of SUPPLIER_CONTRACT_MEMBERS) {
    const present = member.key in m ? m[member.key] !== undefined : false
    const exec = execution(member.key, present, member.probe, mode)
    const base = {
      key: member.key, label: member.label, required: member.required, present, probe: member.probe, executed: exec.executed,
    }
    if (!present) {
      members.push({
        ...base, state: member.required ? 'fail' : 'absent', executed: 'no',
        ...(member.required ? { detail: '必填成员缺失，插件不完整' } : {}),
      })
      continue
    }
    if (member.probe === 'skip') {
      const detail = exec.executed === 'probed'
        ? (await runSideEffectProbe(member.key, m as unknown as SupplierModule)).detail
        : (exec.detail ?? member.skipReason)
      members.push({ ...base, state: 'skipped', detail })
      continue
    }
    const outcome = await runSafeProbe(member.key, m as unknown as SupplierModule)
    members.push({ ...base, state: outcome.ok ? 'ok' : 'fail', detail: outcome.detail })
  }
  const verdict = verdictOf(members, models !== undefined)
  const summary = {
    total: members.length,
    implemented: members.filter((x) => x.present).length,
    ok: members.filter((x) => x.state === 'ok').length,
    fail: members.filter((x) => x.state === 'fail').length,
    absent: members.filter((x) => x.state === 'absent').length,
    skipped: members.filter((x) => x.state === 'skipped').length,
  }
  const listModels = members.find((x) => x.key === 'listModels')
  return {
    supplier: loaded.supplier.id,
    name: loaded.supplier.name,
    mode,
    verdict,
    members,
    core: coreReport(models, listModels?.state === 'ok'),
    summary: { ...summary, ran: members.filter((x) => x.executed !== 'no' && x.present).length },
  }
}

/**
 * 出厂结论。
 *
 * 判据要能真正分出三档，否则 `pass` 只是个摆设：
 * - `fail`：必填成员缺失，或实跑抛错/失败 —— 这个插件不合格。
 * - `warn`：必填齐全且实跑通过，但**有我们没预料到的未验项**，或模型状态拿不到。
 * - `pass`：必填齐全、实跑全过、必填里没有未验项。
 *
 * 两个刻意的口径：
 * 1. **可选成员缺失不降级** —— 契约里它们本就是「按存在性暴露」，不实现不是缺陷
 *    （Loomy 就不实现签到/登录流，它走会话串登录）。按「缺失就 warn」的话谁也拿不到 pass。
 * 2. **`NEVER_RUN` 名单里的必填成员也不降级** —— `chatOnce` 由面板的「跑一次访问测试」
 *    覆盖、`dispose` 本就不可验；它们在报告里逐条写着「为什么没验、谁负责验」。
 *    若把它们也算成 warn，`pass` 就永远不可达 —— 不可达的枚举值等于没有。
 */
function verdictOf(members: ReadonlyArray<ProbeResult>, modelsKnown: boolean): ProbeVerdict {
  if (members.some((x) => x.state === 'fail')) return 'fail'
  const unverified = members.filter((x) => x.required && x.executed === 'no' && NEVER_RUN[x.key] === undefined)
  if (unverified.length > 0 || !modelsKnown) return 'warn'
  return 'pass'
}

/**
 * 深度档：用**无害的探针输入**实跑有副作用的成员，跑通它的代码路径而不动真实状态。
 *
 * 这里返回的 state 一律是 `skipped`（它仍是有副作用的成员），`detail` 说明「用探针输入
 * 试过、结果如何」—— 出厂体检要的就是这个信息。
 */
async function runSideEffectProbe(key: string, m: SupplierModule): Promise<{ detail?: string }> {
  try {
    switch (key) {
      case 'generateLoginUrl': {
        const v = await m.generateLoginUrl?.()
        return { detail: `用探针实跑：${describe(v)}` }
      }
      case 'completeLogin': {
        const v = await m.completeLogin?.(PROBE_CALLBACK)
        return { detail: `用无效回调实跑：${describe(v)}` }
      }
      case 'removeLink': {
        const v = await m.removeLink?.(PROBE_UID)
        return { detail: `用不存在的连接实跑：${describe(v)}` }
      }
      default:
        return {}
    }
  } catch (err) {
    return { detail: `用探针实跑抛错（这本身就是一条问题）：${(err as Error).message}` }
  }
}

/** 核心代劳的能力区：模型启用/禁用状态 + 那几个改配置的操作（只报可用性）。 */
function coreReport(models: ReadonlyArray<{ id: string; enabled: boolean }> | undefined, modelsProbed: boolean): ProbeCoreReport {
  const enabled = models?.filter((m) => m.enabled).length
  const disabled = models === undefined ? undefined : models.length - (enabled ?? 0)
  return {
    models: {
      total: models?.length ?? null,
      enabled: enabled ?? 0,
      disabled: disabled ?? 0,
      ...(models === undefined
        ? { note: modelsProbed ? '拿不到模型列表' : 'listModels 不可用，无法读启用状态' }
        : {}),
    },
    operations: [
      {
        key: 'models.bulk',
        label: '模型全部启用 / 全部禁用',
        available: models !== undefined,
        detail: '会改配置（可逆）。体检只报可用性，不替你点。',
      },
      {
        key: 'models.toggle',
        label: '单个模型启用 / 停用',
        available: models !== undefined,
        detail: '同上。',
      },
    ],
  }
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
      // 这是体检里最有信息量的一条：账号有几个、分别什么状态（冷却 / 失效 / 正常）。
      // 报「≥1」等于没报 —— 链接全过期正是要靠它看出来。
      const r = await probeValue(() => m.status())
      if (!r.ok) return r
      const accounts = accountStates(m.status())
      const summary = accounts.length === 0
        ? '无账号（无账号直连型供应商）'
        : `${accounts.length} 个账号：${accountTally(accounts)}`
      return { ok: true, detail: summary }
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
