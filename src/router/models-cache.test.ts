/**
 * 模型缓存（核心统一）测试 —— 组合面板不该每次都打上游。
 * 用 node --test 跑（Node 原生 TS 剥离，零新依赖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Router } from './index.ts'
import type { ServerResponse } from 'node:http'
import type { ModelInfo, ModelWithEnabled } from './types.ts'
import type { AccountPool } from './account-pool.ts'
import type { ChatOnceResult, SupplierAccountNow, SupplierStatusNow } from '../suppliers/contract.ts'
import { AccountPool as Pool } from './account-pool.ts'

/**
 * 记 listModels 调用次数的假供应商。
 * 默认带一个账号（走真实账号循环），模型不属于自己时报 no_such_model
 * （与真实插件一致）。
 */
function supplier(id: string, models: ModelInfo[], delayMs = 0) {
  const state = { calls: 0 }
  const accts: SupplierAccountNow[] = [{ uid: 'u1', credits: 0, state: 'ok' }]
  return {
    state,
    s: {
      id,
      name: id,
      priority: 0,
      status: (): SupplierStatusNow => ({ id, name: id, accounts: accts }),
      listModels: async (): Promise<ModelInfo[]> => {
        state.calls += 1
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        return models
      },
      modelsWithEnabled: async (): Promise<ModelWithEnabled[]> =>
        models.map((m) => ({ ...m, enabled: true })),
      getAlias: (): string => id,
      accounts: (): SupplierAccountNow[] => accts,
      chatOnce: async (uid: string, req: { rawBody: string }): Promise<ChatOnceResult> => {
        const m = (JSON.parse(req.rawBody) as { model?: string }).model ?? ''
        if (!models.some((mm) => mm.id === m)) {
          return { ok: false, state: 'no_such_model', message: `unknown model ${m}` }
        }
        void uid
        return { ok: true, status: 200, body: '{"ok":1}' }
      },
      dispose: (): void => {},
      pool: new Pool() as AccountPool,
    },
  }
}

/** 丢弃响应的假 ServerResponse。 */
function fakeRes(): ServerResponse {
  return {
    writeHead: (): unknown => undefined,
    end: (): unknown => undefined,
    write: (): boolean => true,
    once: (): unknown => undefined,
    removeListener: (): unknown => undefined,
    destroy: (): unknown => undefined,
  } as unknown as ServerResponse
}

function addSupplier(router: Router, s: unknown): void {
  // supplierModels/modelsOf 走 this.suppliers，测试里直接塞进去
  ;(router as unknown as { suppliers: unknown[] }).suppliers.push(s)
}

test('组合面板连开两次只拉一次上游（缓存生效）', async () => {
  const router = new Router('')
  const a = supplier('a', [{ id: 'a-1' }])
  const b = supplier('b', [{ id: 'b-1' }])
  addSupplier(router, a.s)
  addSupplier(router, b.s)

  await router.supplierModels()
  await router.supplierModels()
  await router.supplierModels()

  assert.equal(a.state.calls, 1)
  assert.equal(b.state.calls, 1)
})

test('detail 与 combos 共用同一份缓存', async () => {
  const router = new Router('')
  const a = supplier('a', [{ id: 'a-1' }])
  addSupplier(router, a.s)

  const viaDetail = await router.modelsOf('a')
  const viaCombos = await router.supplierModels()

  assert.equal(a.state.calls, 1)
  assert.equal(viaDetail.length, 1)
  assert.equal(viaCombos[0]?.models.length, 1)
})

test('各供应商并行拉取：总耗时取最慢的那个，不是累加', async () => {
  const router = new Router('')
  // 三个各慢 200ms：串行会是 600ms+，并行约 200ms
  for (const id of ['s1', 's2', 's3']) addSupplier(router, supplier(id, [{ id: `${id}-m` }], 200).s)

  const t0 = Date.now()
  await router.supplierModels()
  const dt = Date.now() - t0

  assert.ok(dt < 500, `并行拉取应在 500ms 内，实测 ${dt}ms`)
})

test('失效缓存后重新拉取；force 强制刷新', async () => {
  const router = new Router('')
  const a = supplier('a', [{ id: 'a-1' }])
  addSupplier(router, a.s)

  await router.modelsOf('a')
  assert.equal(a.state.calls, 1)

  router.invalidateModels('a')
  await router.modelsOf('a')
  assert.equal(a.state.calls, 2)

  await router.modelsOf('a', true)
  assert.equal(a.state.calls, 3)
})

test('单个供应商拉模型失败不影响其它供应商', async () => {
  const router = new Router('')
  const bad = supplier('bad', [])
  bad.s.listModels = async (): Promise<ModelInfo[]> => {
    throw new Error('upstream down')
  }
  const good = supplier('good', [{ id: 'g-1' }])
  addSupplier(router, bad.s)
  addSupplier(router, good.s)

  const groups = await router.supplierModels()
  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.supplier.id, 'good')
})

test('未知供应商返回空，不抛错', async () => {
  const router = new Router('')
  assert.deepEqual(await router.modelsOf('nonexistent'), [])
})

/**
 * 回归：客户端要非流式、供应商只给流（如 codebuddy 强制 stream:true）时，
 * 核心必须聚合成 JSON——响应写入归核心，协议错配得核心吸收。
 * 否则客户端按 JSON 解析会在 SSE delta 里找不到工具名，报 unknown tool ""。
 */
test('要 JSON 却拿到流 → 聚合成非流式响应，工具名不丢', async () => {
  const router = new Router('')
  const cb = supplier('cb', [{ id: 'hy4-preview' }])
  // 模拟只支持流式的供应商：name 在首块，arguments 分两段
  cb.s.chatOnce = async (): Promise<ChatOnceResult> => ({
    ok: true,
    stream: new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder()
        c.enqueue(enc.encode('data: {"id":"cmpl-1","model":"hy4-preview","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":""}}]}}]}\n\n'))
        c.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\": \\"ls -la\\"}"}}]}}]}\n\n'))
        c.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"total_tokens":42}}\n\n'))
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      },
    }),
  })
  addSupplier(router, cb.s)

  let ctype = ''
  let out = ''
  const res = {
    writeHead: (_c: number, h?: Record<string, string>): void => { ctype = h?.['Content-Type'] ?? '' },
    write: (b: Uint8Array | string): boolean => { out += Buffer.from(b).toString(); return true },
    end: (b?: Uint8Array | string): void => { if (b !== undefined) out += Buffer.from(b).toString() },
    once: (): void => {},
    removeListener: (): void => {},
    destroy: (): void => {},
  } as unknown as ServerResponse

  await router.chatCompletions({ model: 'cb/hy4-preview', stream: false, rawBody: JSON.stringify({ model: 'cb/hy4-preview', stream: false, messages: [] }) }, res)

  assert.match(ctype, /application\/json/, `客户端要 JSON 就该给 JSON，实际 ${ctype}`)
  const o = JSON.parse(out) as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>; usage?: unknown }
  const tc = o.choices?.[0]?.message?.tool_calls?.[0]
  assert.equal(tc?.function?.name, 'bash', '工具名必须保住（否则下游 unknown tool ""）')
  assert.deepEqual(JSON.parse(tc?.function?.arguments ?? ''), { command: 'ls -la' }, '分段的 arguments 要拼成合法 JSON')
  assert.equal(o.choices?.[0]?.finish_reason, 'tool_calls')
  assert.ok(o.usage !== undefined, 'usage 要带上')
})

test('要流式就原样流式，不能被聚合（否则首字节延迟爆炸）', async () => {
  const router = new Router('')
  const cb = supplier('cb', [{ id: 'm' }])
  cb.s.chatOnce = async (): Promise<ChatOnceResult> => ({
    ok: true,
    stream: new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')); c.close() },
    }),
  })
  addSupplier(router, cb.s)

  let ctype = ''
  let out = ''
  const res = {
    writeHead: (_c: number, h?: Record<string, string>): void => { ctype = h?.['Content-Type'] ?? '' },
    write: (b: Uint8Array | string): boolean => { out += Buffer.from(b).toString(); return true },
    end: (): void => {},
    once: (): void => {},
    removeListener: (): void => {},
    destroy: (): void => {},
  } as unknown as ServerResponse

  await router.chatCompletions({ model: 'cb/m', stream: true, rawBody: JSON.stringify({ model: 'cb/m', stream: true, messages: [] }) }, res)

  assert.match(ctype, /event-stream/, '要流式就该给 SSE')
  assert.ok(out.includes('data: [DONE]'), '原始 SSE 帧要原样透传')
})

/** 请求日志要能回答「这个组合到底用的哪个模型和账号」——排障全靠它。 */
test('每次 chat 记一行：组合名 → 供应商/模型 (账号) 结果', async () => {
  const lines: string[] = []
  const router = new Router('', undefined, (m) => lines.push(m))
  const ok = supplier('supA', [{ id: 'a-m' }])
  addSupplier(router, ok.s)
  assert.equal(router.createCombo('combo1', 'fallback', ['supA,a-m']).ok, true)

  const res = {
    writeHead: (): void => {},
    write: (): boolean => true,
    end: (): void => {},
    once: (): void => {},
    removeListener: (): void => {},
    destroy: (): void => {},
  } as unknown as ServerResponse
  await router.chatCompletions({ model: 'combo1', stream: false, rawBody: JSON.stringify({ model: 'combo1', messages: [] }) }, res)

  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? '', /^chat "combo1" → supA\/a-m \(u1\) ok \d+ms$/, `日志格式不对: ${lines[0]}`)
})

test('失败的成员也要记，且带真实原因（不能笼统写 no account）', async () => {
  const lines: string[] = []
  const router = new Router('', undefined, (m) => lines.push(m))
  const dead = supplier('dead', [{ id: 'dead-m' }])
  dead.s.chatOnce = async (): Promise<ChatOnceResult> => ({
    ok: true,
    stream: new ReadableStream<Uint8Array>({ start(c) { c.error(new Error('刚连上就断')) } }),
  })
  const live = supplier('live', [{ id: 'live-m' }])
  addSupplier(router, dead.s)
  addSupplier(router, live.s)
  assert.equal(router.createCombo('c1', 'fallback', ['dead,dead-m', 'live,live-m']).ok, true)

  const res = {
    writeHead: (): void => {},
    write: (): boolean => true,
    end: (): void => {},
    once: (): void => {},
    removeListener: (): void => {},
    destroy: (): void => {},
  } as unknown as ServerResponse
  await router.chatCompletions({ model: 'c1', stream: true, rawBody: JSON.stringify({ model: 'c1', messages: [] }) }, res)

  assert.equal(lines.length, 2, '每个成员一行')
  assert.ok((lines[0] ?? '').includes('dead/dead-m 失败'), `失败成员要记: ${lines[0]}`)
  assert.ok((lines[0] ?? '').includes('stream failed before first byte'), `要带真实原因: ${lines[0]}`)
  assert.ok((lines[1] ?? '').includes('ok'), `成功的要记: ${lines[1]}`)
})

/**
 * 回归：上游「刚连上就断」时组合必须回退到下一个模型。
 * 之前 writeChatResult 先写响应头再 pipe，且把 pipe 错误吞掉 —— 于是返回
 * 「成功」但一个字节都没写，客户端拿到空/截断的 SSE，表现为工具调用名是
 * 空串（Tool call Error: unknown tool ""）。
 */
test('流在写出第一个字节前就断 → 组合回退到下一个模型', async () => {
  const router = new Router('')
  const dead = supplier('dead', [{ id: 'dead-m' }])
  dead.s.chatOnce = async (): Promise<ChatOnceResult> => ({
    ok: true,
    stream: new ReadableStream<Uint8Array>({ start(c) { c.error(new Error('上游刚连上就断')) } }),
  })
  const live = supplier('live', [{ id: 'live-m' }])
  // 兜底模型要返回真的 SSE 流，才贴近组合的真实场景
  live.s.chatOnce = async (): Promise<ChatOnceResult> => ({
    ok: true,
    stream: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"兜底"}}]}\n\ndata: [DONE]\n\n'))
        c.close()
      },
    }),
  })
  addSupplier(router, dead.s)
  addSupplier(router, live.s)
  assert.equal(router.createCombo('c1', 'fallback', ['dead,dead-m', 'live,live-m']).ok, true)

  let out = ''
  let heads = 0
  const res = {
    writeHead: (): void => { heads += 1 },
    write: (b: Uint8Array | string): boolean => { out += Buffer.from(b).toString(); return true },
    end: (): void => {},
    once: (): void => {},
    removeListener: (): void => {},
    destroy: (): void => {},
  } as unknown as ServerResponse
  await router.chatCompletions({ model: 'c1', stream: true, rawBody: JSON.stringify({ model: 'c1', messages: [] }) }, res)

  assert.ok(out.includes('[DONE]'), `应拿到完整响应，实际: ${JSON.stringify(out)}`)
  assert.equal(heads, 1, '响应头只应提交一次')
})

/**
 * 已写出字节后断流：诚实截断，不回退也不二次写头 —— 但要**补一个终止帧**。
 *
 * 客户端（dsh-llm adapter）严格等 `[DONE]` 才认为流正常结束；缺了就抛
 * `SSE payload stream ended without [DONE]`，整轮判失败，已经吐出去的内容
 * 全部作废。所以核心补终止帧：断流降级为「拿到截断内容并正常收尾」，
 * 而不是「整轮白干」。
 */
test('已写出字节后断流 → 截断并补 [DONE]，不回退也不二次写头', async () => {
  const router = new Router('')
  const half = supplier('half', [{ id: 'half-m' }])
  half.s.chatOnce = async (): Promise<ChatOnceResult> => ({
    ok: true,
    stream: new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'))
        await new Promise((r) => setTimeout(r, 30)) // 确保字节已投递
        c.error(new Error('上游中途断流'))
      },
    }),
  })
  const live = supplier('live', [{ id: 'live-m' }])
  live.s.chatOnce = async (): Promise<ChatOnceResult> => ({
    ok: true,
    stream: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"兜底"}}]}\n\ndata: [DONE]\n\n'))
        c.close()
      },
    }),
  })
  addSupplier(router, half.s)
  addSupplier(router, live.s)
  assert.equal(router.createCombo('c2', 'fallback', ['half,half-m', 'live,live-m']).ok, true)

  let out = ''
  let heads = 0
  const res = {
    writeHead: (): void => { heads += 1 },
    write: (b: Uint8Array | string): boolean => { out += Buffer.from(b).toString(); return true },
    end: (): void => {},
    once: (): void => {},
    removeListener: (): void => {},
    destroy: (): void => {},
  } as unknown as ServerResponse
  await router.chatCompletions({ model: 'c2', stream: true, rawBody: JSON.stringify({ model: 'c2', messages: [] }) }, res)

  assert.ok(out.includes('半截'), '已投递的字节要送达客户端')
  assert.ok(out.includes('data: [DONE]'), '断流要补终止帧，否则客户端整轮判失败')
  assert.equal(out.match(/\[DONE\]/g)?.length ?? 0, 1, '终止帧只能有一个（重复会坑客户端）')
  assert.ok(!out.includes('兜底'), '已提交就不该再接第二个模型的内容（会串流）')
  assert.equal(heads, 1, '响应头只能提交一次')
})

/** 上游自己发了终止帧就别再补一个（重复 [DONE] 同样坑客户端）。 */
test('上游已发 [DONE] → 不重复补', async () => {
  const router = new Router('')
  const s = supplier('sup', [{ id: 'm' }])
  s.s.chatOnce = async (): Promise<ChatOnceResult> => ({
    ok: true,
    stream: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"完整"}}]}\n\ndata: [DONE]\n\n'))
        c.close()
      },
    }),
  })
  addSupplier(router, s.s)

  let out = ''
  const res = {
    writeHead: (): void => {},
    write: (b: Uint8Array | string): boolean => { out += Buffer.from(b).toString(); return true },
    end: (): void => {},
    once: (): void => {},
    removeListener: (): void => {},
    destroy: (): void => {},
  } as unknown as ServerResponse
  await router.chatCompletions({ model: 'sup/m', stream: true, rawBody: JSON.stringify({ model: 'sup/m', messages: [] }) }, res)

  assert.equal(out.match(/\[DONE\]/g)?.length ?? 0, 1, `终止帧不能重复，实际: ${JSON.stringify(out)}`)
})

/**
 * 一个字节都没写出就断 → 绝不能补 [DONE]。
 * 补了就等于把这次失败坐实成一个空响应，组合回退（换号/换模型）就废了。
 */
test('首字节前就断 → 不补 [DONE]，留给组合回退', async () => {
  const router = new Router('')
  const dead = supplier('dead', [{ id: 'dead-m' }])
  dead.s.chatOnce = async (): Promise<ChatOnceResult> => ({
    ok: true,
    stream: new ReadableStream<Uint8Array>({ start(c) { c.error(new Error('上游刚连上就断')) } }),
  })
  const live = supplier('live', [{ id: 'live-m' }])
  live.s.chatOnce = async (): Promise<ChatOnceResult> => ({
    ok: true,
    stream: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"兜底"}}]}\n\ndata: [DONE]\n\n'))
        c.close()
      },
    }),
  })
  addSupplier(router, dead.s)
  addSupplier(router, live.s)
  assert.equal(router.createCombo('c3', 'fallback', ['dead,dead-m', 'live,live-m']).ok, true)

  let out = ''
  const res = {
    writeHead: (): void => {},
    write: (b: Uint8Array | string): boolean => { out += Buffer.from(b).toString(); return true },
    end: (): void => {},
    once: (): void => {},
    removeListener: (): void => {},
    destroy: (): void => {},
  } as unknown as ServerResponse
  await router.chatCompletions({ model: 'c3', stream: true, rawBody: JSON.stringify({ model: 'c3', messages: [] }) }, res)

  assert.equal(out.match(/\[DONE\]/g)?.length ?? 0, 1, '只有兜底那个流该有终止帧')
  assert.ok(out.includes('兜底'), '必须回退到下一个模型')
})

/**
 * 对照组：插件若用 unavailable 表示「不是我的模型」就会污染账号——
 * 这正是当初把 no_such_model 加进契约的原因（unavailable 在 RULES 里计数）。
 * 这条锁住「为什么必须区分这两个状态」，别退化回去。
 */
test('对照：用 unavailable 表示「不是我的模型」会污染账号', async () => {
  const router = new Router('')
  const other = supplier('other', [{ id: 'other-m' }])
  // 模拟旧行为：不是我的模型也报 unavailable（会计数）
  other.s.chatOnce = async (): Promise<ChatOnceResult> =>
    ({ ok: false, state: 'unavailable', message: 'not my model' })
  addSupplier(router, other.s)

  const req = { model: 'want-m', stream: false, rawBody: JSON.stringify({ model: 'want-m', messages: [] }) }
  for (let i = 0; i < 5; i++) await router.chatCompletions(req, fakeRes())

  const acc = other.s.pool.decorate([{ uid: 'u1', credits: 0, state: 'ok' }])[0]
  assert.equal(acc?.cooling, true, 'unavailable 会计数，攒够阈值就该冷却——这正说明必须区分状态')
})

/**
 * 回归：组合里指定别人家的模型，不能把无关供应商的账号攒错误冷却掉。
 * 历史上插件用 unavailable 表示「不是我的模型」，核心计成连续错误，
 * 攒够 3 次就把无辜账号冷却 10 分钟——组合越用越「没号可用」。
 */
test('组合请求不污染无关供应商的账号（no_such_model 不记账）', async () => {
  const router = new Router('')
  const other = supplier('other', [{ id: 'other-m' }])
  const target = supplier('target', [{ id: 'want-m' }])
  addSupplier(router, other.s)
  addSupplier(router, target.s)

  const req = { model: 'want-m', stream: false, rawBody: JSON.stringify({ model: 'want-m', messages: [] }) }
  const res = fakeRes()
  // 连打 5 次（远超错误阈值 3）
  for (let i = 0; i < 5; i++) await router.chatCompletions(req, res)

  const acc = other.s.pool.decorate([{ uid: 'u1', credits: 0, state: 'ok' }])[0]
  assert.equal(acc?.err_count, 0, '不该累计连续错误')
  assert.equal(acc?.cooling, false, '不该被冷却')
  assert.equal(acc?.disabled, false, '不该被禁用')
})

/**
 * 回归：CodeBuddy 上游的工具调用第二个 delta 会**显式发空串** name 和 id
 * （OpenAI 规范里后续 delta 应当省略，客户端沿用首帧）。客户端（dsh）判空用
 * `!== void 0`，空串过不了这个判断，首帧的 "bash" 就被 "" 冲掉 → 工具名变空，
 * 下游报 `unknown tool ""`，而 arguments 独立累积所以「参数对、名字空」。
 *
 * 核心是流式响应的唯一写入方，必须在转发时把这些空字段剥掉。
 * 帧数据取自真实上游（hy4-preview 工具调用）。
 */
test('流式：剥掉上游多发一次的空白 tool_call name/id', async () => {
  const router = new Router('')
  const cb = supplier('cb', [{ id: 'hy4-preview' }])
  const REAL = [
    'data: {"id":"cmb-1","model":"hy4-preview","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"","tool_calls":[{"id":"chatcmpl-tool-a7ee5a0d3c361c7f","type":"function","function":{"name":"bash","arguments":""},"index":0}]},"finish_reason":""}]}\n\n',
    'data: {"id":"cmb-1","model":"hy4-preview","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"","tool_calls":[{"id":"","function":{"name":"","arguments":"{\\"command\\": \\"echo hello\\"}"},"index":0}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  cb.s.chatOnce = async (): Promise<ChatOnceResult> => ({
    ok: true,
    stream: new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(REAL)); c.close() },
    }),
  })
  addSupplier(router, cb.s)

  let out = ''
  const res = {
    writeHead: (): void => {},
    write: (b: Uint8Array | string): boolean => { out += Buffer.from(b).toString(); return true },
    end: (): void => {},
    once: (): void => {},
    removeListener: (): void => {},
    destroy: (): void => {},
  } as unknown as ServerResponse
  await router.chatCompletions({ model: 'cb/hy4-preview', stream: true, rawBody: JSON.stringify({ model: 'cb/hy4-preview', stream: true, messages: [] }) }, res)

  // 按 dsh 的合并规则跑一遍：name !== void 0 就覆盖
  let name: string | undefined
  let callId: string | undefined
  let args = ''
  for (const line of out.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (payload === '[DONE]') continue
    const o = JSON.parse(payload) as { choices?: Array<{ delta?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> }
    for (const tc of o.choices?.[0]?.delta?.tool_calls ?? []) {
      if (tc.id !== undefined) callId = tc.id
      if (tc.function?.name !== undefined) name = tc.function.name
      args += tc.function?.arguments ?? ''
    }
  }
  assert.equal(name, 'bash', `工具名必须保住（空了就会 unknown tool ""），实际 ${JSON.stringify(name)}`)
  assert.equal(callId, 'chatcmpl-tool-a7ee5a0d3c361c7f', 'callId 也不能被空串冲掉')
  assert.deepEqual(JSON.parse(args), { command: 'echo hello' }, 'arguments 正常累积')
})
