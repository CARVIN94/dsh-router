/**
 * 扩展 (Ext) 工具委派 —— dsh-router 在 `tools/execute` 拦截 bash 调用，
 * 把命令喂给 `router.ext` 表里 **enabled 且 ready** 的扩展器，命中则短路。
 *
 * 挂点：`tools/execute` 是 around-dispatch waterfall。我们不调 `next()` 短路整条
 * 链路（hooks-claude-code / hooks-codex 的 deny 都是这么做的）。改写在 token 冻结
 * 之后、工具 body 执行之前发生：sandbox 审批 / guard 等前置已在 prepare 阶段做过，
 * 我们只在**同一授权的调用**里换命令字符串，不绕过任何审批。
 *
 * 关键不变量：
 *   - 只拦截 `name === 'bash'`。其他工具（含 run_code 体内自起的子进程读取）不动。
 *   - 按表内注册顺序取**第一个**能改写的扩展器使其生效（`router.ext` 表同
 *     `router.suppliers`：core 持有空表，扩展插件往里 append）。
 *   - 命中后直接调该 bash 工具定义的 `execute(改写后参数, exec)`，返回
 *     `{ isError:false, value }` 由 registry 用名义 arguments（原始命令）re-render。
 *   - 无扩展器 / 都不命中 / 无 tools 服务 → 调 `next()` 原样执行，命令永不因扩展
 *     而失败。
 *
 * tools 服务懒查（每次 bash 调用时），与加载顺序解耦：dsh-router 可早于 agent 工具
 * 组合挂载，工具装齐后自然生效。
 */
import type { ExtState, RewriteResult, RouterExt, RouterExtService } from './contract.ts'
import type { ExtStore } from './store.ts'

/** Pending-call 的最小形状（只取我们需要的字段）。 */
interface BashExec {
  name: string
  arguments: unknown
  signal: AbortSignal
  /**
   * 调用方 agent —— **`tools.get()` 必须带它**:工具注册在 agent scope 里,
   * 不带 scope 只查全局视图,查不到 'bash'(实测就卡在这,静默 return next())。
   */
  agent?: unknown
}

/** `bash` 工具参数（只作用于 command 字段）。 */
interface BashArgs {
  command?: unknown
  [k: string]: unknown
}

/** around-wrapper 返回的规范化结果（registry 能消费的形状）。 */
interface Envelope {
  isError: boolean
  value?: unknown
  error?: { message: string }
  content?: Array<{ type: 'text'; text: string }>
}

/** ToolRuntime 的最小可见面。get 的第二个参数是 scope(agent)。 */
interface ToolRuntimeFace {
  get(name: string, scope?: unknown): { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
}

/**
 * 在「核心已开启 + 插件就绪」的扩展器里找出第一个能给命令改写的。
 *
 * `enabled` 来自核心存储(`isEnabled`),`ready` 来自插件(`getState()`)——
 * 开关归核心、可用性归插件,两者都由核心在此合并裁决。
 */
export function firstRewrite(
  exts: RouterExtService,
  command: string,
  isEnabled: (id: string) => boolean,
): RewriteResult | undefined {
  for (const ext of Object.values(exts)) {
    const e = ext as RouterExt
    if (!e || typeof e.rewrite !== 'function') continue
    if (!isEnabled(e.id)) continue
    let state: ExtState
    try {
      state = e.getState()
    } catch {
      continue
    }
    if (state?.ready !== true) continue
    let result: RewriteResult
    try {
      result = e.rewrite(command)
    } catch {
      continue // 扩展器实现出错：跳过它，别影响执行
    }
    if (result && result.rewritten !== null) return result
  }
  return undefined
}

/**
 * 在 `tools/execute` 上挂 bash 委派。返回清理函数（监听随 fiber 卸载自动注销，
 * 返回值仅供显式组合）。
 */
export function mountExtProxy(
  ctx: { get: (name: string) => unknown; on: (name: string, listener: (...args: unknown[]) => void) => unknown },
  getTable: () => RouterExtService | undefined,
  store: ExtStore,
): () => void {
  const isEnabled = (id: string): boolean => store.isEnabled(id)
  // tools 服务懒查（与加载顺序解耦，见文件头注释）。
  const toolsOf = (): ToolRuntimeFace | undefined => {
    const t = ctx.get('tools')
    return t && typeof (t as { get?: unknown }).get === 'function' ? t as ToolRuntimeFace : undefined
  }

  const listener = async (
    exec: BashExec,
    next: () => Promise<Envelope>,
  ): Promise<Envelope> => {
    if (exec.name !== 'bash' || exec.signal.aborted) return next()
    const args = exec.arguments as BashArgs
    const cmd = args?.command
    if (typeof cmd !== 'string' || cmd.trim() === '') return next()

    const table = getTable()
    if (!table) return next()
    const result = firstRewrite(table, cmd, isEnabled)
    if (!result) return next()

    const tools = toolsOf()
    if (!tools) return next()
    // 必须带 agent scope:bash 工具注册在 agent scope,不带 scope 只查全局视图会
    // 查不到(实测坑:静默走 next(),从不改写)。
    const bashTool = tools.get('bash', exec.agent)
    if (!bashTool) return next()

    const rewrittenArgs: BashArgs = { ...args, command: result.rewritten }
    try {
      const value = await bashTool.execute(rewrittenArgs, exec)
      // 交给 registry 用名义 arguments（原始命令）re-render。
      return { isError: false, value } as Envelope
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        isError: true,
        error: { message },
        content: [{ type: 'text', text: `Error: ${message}` }],
      } as Envelope
    }
  }

  ctx.on('tools/execute', listener as never)
  return () => {}
}