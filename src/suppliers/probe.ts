/**
 * 供应商插件的**契约体检**：逐个成员报告「实现了吗 / 实跑通了吗 / 为什么没跑」。
 *
 * 为什么不直接在客户端遍历：契约成员活在**宿主进程**里的模块实例上
 * （`wrapModule` 把它挂在 `supplier.__module`），客户端只看得见 `/health` 摘要里
 * 那 5 个能力名 —— 那是 `DIFF_CAPS`，不是契约全貌。所以探测必须在核心里做。
 *
 * ## 最重要的约束：绝不代替用户做有副作用的事
 *
 * 「把所有功能跑一遍」听起来很爽，但契约里有一批成员**不能自动调**：
 * `dispose` 调了就是卸载这个供应商；`addApiKey` 写凭证；`removeLink` 删凭证；
 * `generateLoginUrl` 很可能直接触发设备码/OAuth 流。
 * 那些**不出现在报告里**（见 `PROBE_EXCLUDED_MEMBERS`）—— 体检是给眼睛看的，
 * 占一行只为说「没验」，是用篇幅淹掉真问题。
 * 剩下的成员一律实跑（需要真实账号/额度的用连接池里的 token 真跑一次）。
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
 * 体检只有**一档，全自动**。
 *
 * 前提由使用者保证：连接池里已经有一个可用的 token。所以「每个功能到底通不通」这个问题
 * 是可以被回答的 —— 于是能跑的就都跑掉：
 * - 没有副作用的成员直接实跑；
 * - 有副作用但可以用**无害探针输入**跑通代码路径的也实跑（`removeLink` 传不存在的
 *   uid、`completeLogin` 传无效回调 URL、`generateLoginUrl` 直接调）；
 * - 需要真实账号/真实额度的也实跑（`chatOnce` 走 `router.testModel` 真发一次、
 *   `checkinNow` 对连接池里的真实连接签到）；
 * - 会破坏体检前提的（`dispose` 卸载自己、`addApiKey` 写凭证…）**不进清单** ——
 *   见 `PROBE_EXCLUDED_MEMBERS`，逐个写了不测的理由。
 *
 * 报告的每个成员都标 `executed`：体检的价值全在「哪些是验过的、哪些只是看了一眼」。
 */
export type ProbeExecuted = 'ran' | 'no'

/** 这个成员是不是有副作用的（`skip` = 需要特别处理：要么探针实跑，要么只报存在性）。 */
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

/**
 * 结果里一条成员的最终状态。
 *
 * `unverified` 与 `fail` 必须分开：**没条件验**（没有 token、没有已启用模型、连接池
 * 为空）不是插件的毛病。压成 fail 会让「用户还没放 token」被出厂结论判成不合格 ——
 * 体检最忌讳把「没测到」说成「测出问题」。
 */
export type ProbeState = 'ok' | 'fail' | 'absent' | 'unverified'

export interface ProbeResult {
  key: string
  label: string
  required: boolean
  present: boolean
  state: ProbeState
  /** 到底跑没跑。`no` 时 `detail` 写清为什么。 */
  executed: ProbeExecuted
  /** 摘要/失败原因；`executed: 'no'` 时这里是「为什么没跑」。 */
  detail?: string
}

/** 体检的外部输入：模型启用状态 + 跑一次真实 `chatOnce` 的入口。 */
export interface ProbeInput {
  /** 该供应商当前的模型启用状态（调用方用 `router.modelsOf` 取，走核心缓存）。 */
  models?: ReadonlyArray<{ id: string; enabled: boolean }>
  /**
   * 跑一次真实调用（`router.testModel`：账号遍历 + 冷却 + 首字节预算都生效）。
   * 调用方决定用哪个模型 / 哪个连接。取不到模型时可以不提供 —— 报告里会写明
   * 「无法验证」而不是假装通过。
   */
  runChatOnce?: (model: string) => Promise<{ ok: boolean; detail: string }>
  /**
   * **真跑一遍「全部禁用 → 全部启用」并还原**。
   *
   * 这不是「只报可用性」—— 它就是体检里能测出「插件在 listModels 里过滤已禁用模型」
   * 越权的那条路径：核心把全部模型标成停用，再拉一次模型列表，**被藏起来的就露馅**
   * （插件以为该藏，核心却必须还能看见它们，否则面板的「已禁用」列表会空、用户再也
   * 看不到自己禁用过什么）。
   *
   * 由调用方实现，**必须自己还原**（体检不该在用户配置上留痕）。
   */
  runBulkToggleRoundTrip?: () => Promise<{ ok: boolean; detail: string }>
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
  /**
   * 核心代劳的能力区。**「全部启用 / 全部禁用」是实跑的**（并还原）：它既是面板上
   * 真实存在的操作，也是体检唯一能验出「插件私自过滤已禁用模型」的办法。
   */
  operations: Array<{ key: string; label: string; ran: boolean; ok?: boolean; detail?: string }>
}

export interface ProbeReport {
  supplier: string
  name: string
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
    /** 实现了但没验（任何输入都会毁掉体检前提）。 */
    unverified: number
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
    key: 'checkinNow',
    label: '签到',
    required: false,
    probe: 'skip',
    skipReason: '会替这个连接真的去签到。',
  },
] as const

/**
 * **故意不列进体检清单的成员**（不是「不跑」，是**不在报告里出现**）：
 *
 * - `completeLogin`：需要一个真实回调 URL 才跑得通，体检拿不到 —— 跑了也只是验
 *   「无效 URL 会不会抛错」，那不是功能是否可用。
 * - `addApiKey`：需要一个真实 API key，自动造一个只会往凭证库写垃圾。
 * - `removeLink`：用不存在的 uid 去试，它当然返回 false —— 那是**正常响应**，
 *   判成失败是体检自己错判功能有问题（踩过）。真要验它只能删一个真连接。
 * - `pollLogin`：只读一个布尔标记，验它通不通没有意义。
 * - `generateLoginUrl`：可能直接触发设备码 / OAuth 登录流，会在上游留下待处理的会话。
 *
 * 保留在清单里、逐条占行、只为说「没验」，是在用篇幅淹掉真问题。
 * 但**契约里加了新成员，体检要能报出来** —— `probe.test.ts` 有一条判据解析
 * `contract.ts` 断言「除了这份有意排除的名单之外必须全覆盖」。
 */
export const PROBE_EXCLUDED_MEMBERS: Record<string, string> = {
  dispose: '调用它就是把这个供应商卸载掉 —— 体检没法在自己身上验自己',
  completeLogin: '需要一个真实回调 URL',
  addApiKey: '需要一个真实 API key',
  removeLink: '只能用真连接验（试删不存在的连接必然返回 false，那是正常响应）',
  pollLogin: '只读一个布尔标记，验它通不通没有意义',
  generateLoginUrl: '可能触发设备码 / OAuth 流，会在上游留下待处理会话',
}

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

/** 第一个连接 uid（`checkinNow` 之类要真实连接时用）。 */
function firstAccountUid(m: SupplierModule): string | undefined {
  return accountStates(m.status())[0]?.uid
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
 *（这里原本有一份「永不实跑」名单：`dispose` / `addApiKey`。
 *   两者都已移出体检清单，名单随之作废 —— 留着空机制比删掉更糟：
 *   它看起来像个可配置的开关，其实没有任何成员会命中。
 *   「为什么要移」见 PROBE_EXCLUDED_MEMBERS。）
 */

/** 深度档用来「不碰真实状态就跑通代码路径」的探针输入。 */
const PROBE_UID = '__probe_no_such_uid__'
const PROBE_CALLBACK = 'https://invalid.example/__probe__'

/**
 * 体检一个已装载的供应商。
 *
 * 只跑 `probe: 'safe'` 的成员；`skip` 的只报存在性。绝不代替用户调有副作用的成员。
 *
 * @param models - 该供应商当前的模型启用状态（由调用方用 `router.modelsOf` 取，
 *   走核心缓存不额外打上游）。取不到就传 undefined —— 报告里会如实写「拿不到」，
 *   不能拿 0 冒充「一个模型都没有」。
 */
export async function probeSupplier(loaded: LoadedSupplier, input: ProbeInput = {}): Promise<ProbeReport> {
  const m = rawModule(loaded)
  const members: ProbeResult[] = []
  for (const member of SUPPLIER_CONTRACT_MEMBERS) {
    const present = member.key in m ? m[member.key] !== undefined : false
    // 清单里的成员一律实跑 —— 会毁掉体检前提的那些（dispose 等）早已移出清单
    const base: Omit<ProbeResult, 'state' | 'detail'> = {
      key: member.key, label: member.label, required: member.required, present,
      executed: present ? 'ran' : 'no',
    }
    if (!present) {
      members.push({
        ...base, state: member.required ? 'fail' : 'absent',
        ...(member.required ? { detail: '必填成员缺失，插件不完整' } : {}),
      })
      continue
    }
    const outcome = member.probe === 'safe'
      ? await runSafeProbe(member.key, m as unknown as SupplierModule, input)
      : await runProbedMember(member.key, m as unknown as SupplierModule, input)
    // 「无法验证」归 unverified（warn 语义），别压成 fail
    members.push({
      ...base,
      state: outcome.ok ? 'ok' : outcome.detail.startsWith('无法验证') ? 'unverified' : 'fail',
      detail: outcome.detail,
    })
  }
  const bulkResult = await runBulkRoundTrip(input)
  const models = input.models
  const verdict = verdictOf(members, models !== undefined, input.runBulkToggleRoundTrip === undefined ? undefined : (await bulkResult).ok)
  const summary = {
    total: members.length,
    implemented: members.filter((x) => x.present).length,
    ok: members.filter((x) => x.state === 'ok').length,
    fail: members.filter((x) => x.state === 'fail').length,
    absent: members.filter((x) => x.state === 'absent').length,
    unverified: members.filter((x) => x.state === 'unverified').length,
  }
  const listModels = members.find((x) => x.key === 'listModels')
  return {
    supplier: loaded.supplier.id,
    name: loaded.supplier.name,
    verdict,
    members,
    core: await coreReport(input, listModels?.state === 'ok', bulkResult),
    summary: { ...summary, ran: members.filter((x) => x.executed === 'ran' && x.present).length },
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
 * 2. **不进清单的成员不降级** —— `chatOnce` 若无法实跑记 `unverified`（warn），
 *    而 `dispose` 之类本就移出了清单，不参与判定。若把它们也算成 warn，`pass` 就
 *    永远不可达 —— 不可达的枚举值等于没有。
 */
function verdictOf(members: ReadonlyArray<ProbeResult>, modelsKnown: boolean, bulkOk: boolean | undefined): ProbeVerdict {
  // 核心区「全部启用/禁用」的实跑结果**必须**计入结论：它就是抓「插件私自过滤已禁用
  // 模型」越权的那条路，失败了却还判 pass，等于体检最该抓的问题被放过。
  if (members.some((x) => x.state === 'fail') || bulkOk === false) return 'fail'
  if (members.some((x) => x.state === 'unverified') || !modelsKnown) return 'warn'
  return 'pass'
}

/**
 * 实跑「有副作用但可以安全试」的成员：要么用**无害探针输入**跑通代码路径，要么用
 * **连接池里的真实连接**真跑一次（前提由使用者保证：池里已放好可用 token）。
 */
async function runProbedMember(key: string, m: SupplierModule, input: ProbeInput): Promise<{ ok: boolean; detail: string }> {
  try {
    switch (key) {
      case 'chatOnce': {
        if (input.runChatOnce === undefined) return { ok: false, detail: '无法验证：没有发起真实调用的入口' }
        const model = input.models?.find((x) => x.enabled)?.id ?? input.models?.[0]?.id
        if (model === undefined) return { ok: false, detail: '无法验证：没有已启用的模型（先启用至少一个）' }
        const r = await input.runChatOnce(model)
        return { ok: r.ok, detail: `真实调用 ${model}：${r.ok ? '通了' : `失败（${r.detail}）`}` }
      }
      case 'checkinNow': {
        const uid = firstAccountUid(m)
        if (uid === undefined) return { ok: false, detail: '无法验证：连接池里没有可用连接（先加一个 token）' }
        const v = await m.checkinNow?.(uid)
        return { ok: v?.ok !== false, detail: `对连接 ${uid} 真实签到：${describe(v)}` }
      }
      case 'generateLoginUrl': {
        const v = await m.generateLoginUrl?.()
        return { ok: true, detail: describe(v) }
      }
      case 'completeLogin': {
        // 成功时返回 {uid,nickname}，失败时抛错 —— 所以「没抛错」就算通过
        const v = await m.completeLogin?.(PROBE_CALLBACK)
        return { ok: true, detail: `无效回调实跑：${describe(v)}（没抛错即通过）` }
      }
      case 'removeLink': {
        const v = await m.removeLink?.(PROBE_UID)
        return { ok: v !== false, detail: `不存在的连接实跑：${describe(v)}` }
      }
      default:
        return { ok: true, detail: '未纳入自动实跑' }
    }
  } catch (err) {
    return { ok: false, detail: `实跑抛错（这本身就是一条问题）：${(err as Error).message}` }
  }
}

/** 核心代劳的能力区：模型启用/禁用状态 + 那几个改配置的操作（只报可用性）。 */
/** 核心区：模型启用状态 + 「全部启用/禁用」实跑结果。 */
async function coreReport(
  input: ProbeInput,
  modelsProbed: boolean,
  bulk: { ran: boolean; ok?: boolean; detail: string },
): Promise<ProbeCoreReport> {
  const models = input.models
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
        ran: bulk.ran,
        ...(bulk.ok === undefined ? {} : { ok: bulk.ok }),
        detail: bulk.detail,
      },
    ],
  }
}

/**
 * 实跑「全部禁用 → 看列表 → 全部启用」。
 *
 * 违规的插件会在这里露馅：它把已禁用的模型从 `listModels` 里过滤掉了，于是全部禁用
 * 之后核心**看不到任何一个模型** —— 用户点「全部启用」也就再也点不回来了
 * （路由里没有可用的模型 id 可传）。
 */
async function runBulkRoundTrip(input: ProbeInput): Promise<{ ran: boolean; ok?: boolean; detail: string }> {
  if (input.runBulkToggleRoundTrip === undefined) {
    return { ran: false, detail: '没有模型可禁用' }
  }
  try {
    const r = await input.runBulkToggleRoundTrip()
    return { ran: true, ok: r.ok, detail: r.detail }
  } catch (err) {
    return { ran: true, ok: false, detail: `实跑抛错：${(err as Error).message}` }
  }
}

/** 无副作用成员的实跑。**每个 case 都必须没有副作用** —— 新增成员时照此办理。 */
async function runSafeProbe(key: string, m: SupplierModule, input: ProbeInput): Promise<{ ok: boolean; detail: string }> {
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
      // 「插件是否在 listModels 里过滤已禁用的模型」不在这里查 —— 那要看「全部禁用」
      // 之后列表还剩多少，由核心区的 runBulkToggleRoundTrip 验（见下）。
      // 在这里查会有个致命前提：得先有用户禁用过模型才查得出来，而出厂体检面对的
      // 恰恰是「用户还没用过的新插件」。
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
