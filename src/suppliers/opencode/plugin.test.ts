/**
 * opencode(OpenCode Zen 免费档)握手契约测试 —— 锁住 2026-10-15 实测的那组硬门。
 *
 * 为什么值得固化：这些**都不是可选优化，缺一即 403**
 * `FreeTierError: OpenCode's free tier can only be used from within OpenCode`。
 * 它们全是「看不出来」的那种约定——代码删掉一行、或把端点/工具名改回去，
 * 单测本该立刻变红，否则下次只能在真机对话里发现整个供应商死了。
 *
 * 实测依据（2026-10-15，逐项消融 + 单因子隔离）：
 *   - 端点必须是 `/inference/v1/chat/completions`：`/zen/v1` 已废弃，
 *     对任何头部/工具组合一律 403（旧实现死在这里）
 *   - `tools` 里必须存在**小写精确名为 `read`** 的工具：
 *     `read` 单独→200；`bash`/`glob`/`write`/`shell` 单独→403；
 *     `read` 改名 `READ`→403；但 `read` 的 `parameters` 完全不看
 *     （`properties:{}`、无 `parameters`、`parameters:null` 全 200）
 *   - session 的 12 位 hex 前缀必须是倒序时间戳且低 12 位 ∈ [0,63]：
 *     纯随机 hex→403、sha256 派生→403、counter=64/300→403
 *   - 非流式（`stream:false`）即使其余齐全也 403 → 必须恒发 stream:true
 *
 * 已实测**不敏感**（故不作为断言，改回旧值也不算错）：UA 具体版本、
 * `x-opencode-client` 的 cli/desktop、工具 description。
 *
 * 用 node --test 跑（Node 原生剥 TS 类型）：
 *   node --test src/suppliers/opencode/plugin.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import factory from './plugin.ts'
import { SupplierConfigStore } from '../../supplier-config.ts'
import type { CredentialStore } from '../../credential-store.ts'
import type { SupplierEnv, SupplierModule } from '../contract.ts'
import type { ChatRequest } from '../../router/types.ts'

/** 上游认的 session/request id 形状：前缀 + 12 位小写 hex + 14 位 base62。 */
const SES_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const MSG_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/** 上游免费档的推理端点。`/zen/v1` 已废弃，出现即回归。 */
const EXPECTED_CHAT_URL = 'https://opencode.ai/inference/v1/chat/completions'

/**
 * 从 session id 还原出 counter：12 位 hex 是 `~(ts * 0x1000 + counter)`，
 * 故先取反还原 `ts * 0x1000 + counter`，再取低 12 位即 counter
 * （`ts * 0x1000` 的低 12 位恒为 0）。
 */
function invertedCounter(id: string): bigint {
  const time = BigInt('0x' + id.slice(4, 16))
  return ~time & 0xffffffffffffn & 0xfffn
}

interface Captured {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** 打桩 globalThis.fetch，接住一次请求（上游返回空 SSE 流即可）。 */
function stubFetch(): { captured: Captured[]; restore: () => void } {
  const captured: Captured[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    captured.push({
      url: String(url),
      headers: init?.headers ?? {},
      body: init?.body !== undefined ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    })
    return new Response(new ReadableStream<Uint8Array>({ start: (c) => c.close() }), { status: 200 })
  }) as unknown as typeof fetch
  return { captured, restore: () => { globalThis.fetch = real } }
}

/** 造一个最小 env（store 空文件路径 = 纯内存，credentials 用不着的空壳）。 */
function makePlugin(): SupplierModule {
  const store = new SupplierConfigStore('')
  const env: SupplierEnv = {
    dataDir: '/tmp',
    log: () => {},
    store,
    credentials: {} as CredentialStore,
  }
  return factory(env)
}

function request(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'big-pickle',
    stream: true,
    rawBody: JSON.stringify({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }),
    ...over,
  }
}

test('chat 必须打 /inference/v1（/zen/v1 已废弃，全组合 403）', async () => {
  const stub = stubFetch()
  try {
    const r = await makePlugin().chatOnce('', 'auto', request())
    assert.equal(r.ok, true, '握手齐全时应当成功')
    assert.equal(stub.captured[0]!.url, EXPECTED_CHAT_URL, '/zen/v1 是本次故障根因，不得回退')
  } finally {
    stub.restore()
  }
})

test('session 的 12 位 hex 必须是倒序时间戳，低 12 位 counter ∈ [0,63]', async () => {
  const stub = stubFetch()
  try {
    await makePlugin().chatOnce('', 'auto', request())
    const h = stub.captured[0]!.headers

    // 形状不对上游是**拒绝**而不是忽略 —— 形状必须严格
    assert.match(h['x-opencode-session'] ?? '', SES_RE, 'x-opencode-session 形状不对会被 403')
    assert.match(h['x-opencode-request'] ?? '', MSG_RE, 'x-opencode-request 形状不对会被 403')

    // 纯随机 hex 与 sha256 派生 hex 都落不进 [0,63] 窗口 → 必然 403
    for (const key of ['x-opencode-session', 'x-opencode-request'] as const) {
      const counter = invertedCounter(h[key]!)
      assert.ok(counter <= 63n, `${key} 的 counter 必须 ∈ [0,63]（实测 64/300 会 403），得到 ${counter}`)
    }
  } finally {
    stub.restore()
  }
})

test('tools 必须含小写 read；bash 不是门，且不得被注入（旧实现的回归点）', async () => {
  const stub = stubFetch()
  try {
    // 调用方明确要非流式 —— 上游免费档对非流式一律 403，插件必须翻成流式
    await makePlugin().chatOnce('', 'auto', request({ stream: false }))
    const body = stub.captured[0]!.body
    assert.equal(body.stream, true, '免费档只支持流式，非流式必须翻成 stream:true')

    const tools = body.tools as Array<{ function?: { name?: string } }>
    const names = tools.map((t) => t.function?.name)
    assert.ok(names.includes('read'), 'tools 缺 read 会被 403')
    // 实测：bash 不是门（bash 单独 → 403），注入它只会污染调用方的工具表
    assert.equal(names.includes('bash'), false, 'bash 不是免费档的门，不该被注入')
    assert.equal(tools.length, 1, '无调用方工具时只应补 read 一个占位')
  } finally {
    stub.restore()
  }
})

test('read 的 parameters 不被检查（空 schema 即可通过）', async () => {
  const stub = stubFetch()
  try {
    await makePlugin().chatOnce('', 'auto', request())
    const tools = stub.captured[0]!.body.tools as Array<{ function: { name: string; parameters?: unknown } }>
    const read = tools.find((t) => t.function.name === 'read')!
    // 上游只看名字，故占位用空 properties 是对的（别"补"成真 schema 增加噪音）
    assert.deepEqual(read.function.parameters, { type: 'object', properties: {} })
  } finally {
    stub.restore()
  }
})

test('调用方自带的同名工具不被占位工具覆盖（read 只补缺）', async () => {
  const stub = stubFetch()
  try {
    const realRead = {
      type: 'function',
      function: { name: 'read', description: 'REAL READ', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } },
    }
    const realBash = {
      type: 'function',
      function: { name: 'bash', description: 'REAL BASH', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    }
    await makePlugin().chatOnce('', 'auto', request({
      rawBody: JSON.stringify({ model: 'big-pickle', messages: [], stream: true, tools: [realRead, realBash] }),
    }))
    const tools = stub.captured[0]!.body.tools as Array<{ function: { name: string; description?: string } }>

    const read = tools.filter((t) => t.function.name === 'read')
    assert.equal(read.length, 1, 'read 不能被注入成两条（否则真实工具签名被挤掉）')
    assert.equal(read[0]!.function.description, 'REAL READ', '调用方自己的定义必须原样保留')
    assert.equal(tools.length, 2, '已有 read 时不该再补任何占位')

    // 调用方的 bash 必须原样留着（它不是门，但也绝不能被删）
    assert.equal(tools.filter((t) => t.function.name === 'bash').length, 1, '调用方的 bash 不得被动')
  } finally {
    stub.restore()
  }
})

test("effort='off' 必须删字段而不是下发（上游没有这个值，会 400）", async () => {
  const stub = stubFetch()
  try {
    // 关键：rawBody 里**本来就带** reasoning_effort/reasoning_summary。
    // 不种这两个字段的话，「删」与「什么都不做」结果一样，闸门形同虚设
    // （实测过：把 else-if 的 'off' 分支去掉，测试照样全绿）。
    await makePlugin().chatOnce('', 'off', request({
      rawBody: JSON.stringify({
        model: 'big-pickle',
        messages: [],
        stream: true,
        reasoning_effort: 'high',
        reasoning_summary: 'auto',
      }),
    }))
    const body = stub.captured[0]!.body
    assert.equal('reasoning_effort' in body, false, "off 要删字段：上游收到 'off' 直接 400 invalid_request_error")
    assert.equal('reasoning_summary' in body, false, 'reasoning_summary 一并删掉')
  } finally {
    stub.restore()
  }
})

test("effort='auto' 不动调用方自己的 reasoning_effort（不误删）", async () => {
  const stub = stubFetch()
  try {
    await makePlugin().chatOnce('', 'auto', request({
      rawBody: JSON.stringify({ model: 'big-pickle', messages: [], stream: true, reasoning_effort: 'high' }),
    }))
    const body = stub.captured[0]!.body
    assert.equal(body.reasoning_effort, 'high', 'auto = 不显式下发，调用方原值必须留着')
  } finally {
    stub.restore()
  }
})

test('非 free 模型报 no_such_model（不记账、不冷号）', async () => {
  const stub = stubFetch()
  try {
    const r = await makePlugin().chatOnce('', 'auto', request({ model: 'gpt-5.5' }))
    assert.equal(r.ok, false)
    assert.equal(r.ok === false ? r.state : '', 'no_such_model', '模型不属于本供应商 → 核心换供应商而不是冷号')
    assert.equal(stub.captured.length, 0, '不属于自己的模型不该打上游')
  } finally {
    stub.restore()
  }
})
