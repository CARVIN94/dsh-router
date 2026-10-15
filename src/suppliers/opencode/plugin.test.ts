/**
 * opencode(Zen 免费档)握手契约测试 —— 锁住 2026-09-22 实测的那组硬门。
 *
 * 为什么值得固化：这四条**都不是可选优化，缺一即 403**
 * `FreeTierError: OpenCode's free tier can only be used from within OpenCode`。
 * 它们全是「看不出来」的那种约定——代码删掉一行 headers、或把 UA 改回
 * `opencode`，单测本该立刻变红，否则下次只能在真机对话里发现整个供应商死了。
 *
 * 实测依据（2026-09-22，逐项消融验证）：
 *   - UA 必须带版本且 ≥1.18：裸 `opencode`→403；`opencode/1.17.x`→426；1.18.0 起 200
 *   - 必须同时有 `x-opencode-session`/`x-opencode-request`，且形状是
 *     `ses_<12hex><14base62>` / `msg_<同形状>`——格式错也 403
 *   - tools 里必须**同时**有 bash 和 read，只给一个也 403
 *   - 非流式（`stream:false`）即使三样齐全也 403 → 必须恒发 stream:true
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

test('chatOnce 必须带版本化 UA + 合法形状的 session/request 头', async () => {
  const stub = stubFetch()
  try {
    const r = await makePlugin().chatOnce('', 'auto', request())
    assert.equal(r.ok, true, '握手齐全时应当成功')
    const h = stub.captured[0]!.headers

    // UA 必须带版本号（裸 'opencode' 会被上游按非 CLI 拒掉）
    assert.match(h['User-Agent'] ?? '', /^opencode\/\d+\.\d+/, 'UA 必须带 opencode/ 版本号')

    // session/request 形状不对上游是**拒绝**而不是忽略 —— 形状必须严格
    assert.match(h['x-opencode-session'] ?? '', SES_RE, 'x-opencode-session 形状不对会被 403')
    assert.match(h['x-opencode-request'] ?? '', MSG_RE, 'x-opencode-request 形状不对会被 403')
  } finally {
    stub.restore()
  }
})

test('请求体恒为流式，且 tools 同时含 bash 与 read', async () => {
  const stub = stubFetch()
  try {
    // 调用方明确要非流式 —— 上游免费档对非流式一律 403，插件必须翻成流式
    await makePlugin().chatOnce('', 'auto', request({ stream: false }))
    const body = stub.captured[0]!.body
    assert.equal(body.stream, true, '免费档只支持流式，非流式必须翻成 stream:true')

    const names = (body.tools as Array<{ function?: { name?: string } }>).map((t) => t.function?.name)
    assert.ok(names.includes('bash'), 'tools 缺 bash 会被 403')
    assert.ok(names.includes('read'), 'tools 缺 read 会被 403')
  } finally {
    stub.restore()
  }
})

test('调用方自带的同名工具不被占位工具覆盖（bash/read 只补缺）', async () => {
  const stub = stubFetch()
  try {
    const realBash = {
      type: 'function',
      function: { name: 'bash', description: 'REAL BASH', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    }
    await makePlugin().chatOnce('', 'auto', request({
      rawBody: JSON.stringify({ model: 'big-pickle', messages: [], stream: true, tools: [realBash] }),
    }))
    const tools = stub.captured[0]!.body.tools as Array<{ function: { name: string; description?: string } }>

    const bash = tools.filter((t) => t.function.name === 'bash')
    assert.equal(bash.length, 1, 'bash 不能被注入成两条（否则真实工具签名被挤掉）')
    assert.equal(bash[0]!.function.description, 'REAL BASH', '调用方自己的定义必须原样保留')

    // read 缺失 → 补上；bash 已有 → 不重复
    assert.ok(tools.some((t) => t.function.name === 'read'), '缺的 read 要补上')
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
