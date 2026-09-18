/**
 * 客户端断开的连接回收测试 —— issue #6「组合模型用久了报 connection error」的真根因。
 *
 * 现象：把 `http://127.0.0.1:3080/v1` 加为**自定义供应商**（llm-pi-ai 的
 * openai-completions）后，连续用半天到一天就全面 connection error；内置 Router
 * 供应商同一个组合却正常。
 *
 * 真根因（**不是**「undici 每 origin 限 10 socket」——那条实测不成立，见下）：
 * 客户端主动断开时，服务端 `writeChatResult` 只监听 `res` 的 `'error'`，**不监听
 * `'close'`**。对端关闭触发的是 `'close'`，于是：
 *   - 上游流还在推 → `writeChunk` 里 `res.write` 返回 false → 挂起等 `'drain'`
 *   - 连接已死 → `'drain'` 永不到来 → `pipeTo` 永不 settle
 *   - → `finally` 不执行 → 上游 fetch body **永不 cancel**
 *   → 每次「客户端放弃」漏一条上游 TCP 连接 + 挂一个请求；长跑累积到 fd/端口耗尽。
 *
 * 为什么只有自定义供应商路径中招：pi-ai 有**流空闲超时**（idleWatchdog，默认
 * 300s）和消费方提前退出时的 `consumer.abort()`，会**主动放弃**请求；而 dsh-router
 * 自己的 adapter 不设任何超时、从不主动放弃 → 内置路径几乎不触发这条泄漏。
 *
 * 为什么「每 origin 10 socket」的解释不成立：实测（探针 I）连续泄漏 200 次
 * **全部成功、无排队**（单次 ≤10ms），undici 会自行关闭多余连接 —— 默认 fetch
 * 没有这个硬上限，所以「池满 → 全部 connection error」推不出来。
 *
 * 用 node --test 跑（Node 原生 TS 剥离，零新依赖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Router } from './index.ts'
import { AccountPool } from './account-pool.ts'
import type { ChatOnceResult, SupplierAccountNow, SupplierStatusNow } from '../suppliers/contract.ts'
import type { ModelInfo } from './types.ts'

/**
 * 造一个**永不结束**的上游流（模拟长生成），并记录它有没有被 cancel。
 * `enqueued` 用来证明「断开后服务端是否还在继续消费」。
 */
function infiniteStream(): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean; enqueued: () => number } {
  const enc = new TextEncoder()
  let cancelled = false
  let enqueued = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      timer = setInterval(() => {
        try { ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')); enqueued += 1 } catch { /* closed */ }
      }, 20)
    },
    cancel() { cancelled = true; if (timer !== undefined) clearInterval(timer) },
  })
  return { stream, cancelled: () => cancelled, enqueued: () => enqueued }
}

function supplierWith(stream: ReadableStream<Uint8Array>) {
  return {
    id: 'sup', name: 'sup', priority: 0, pool: new AccountPool('sup'),
    status: (): SupplierStatusNow => ({ id: 'sup', name: 'sup', accounts: [] }),
    listModels: async (): Promise<ModelInfo[]> => [{ id: 'm1' }],
    accounts: (): SupplierAccountNow[] => [{ uid: 'u1', credits: 0, state: 'ok' }],
    getAlias: () => 'sup',
    chatOnce: async (): Promise<ChatOnceResult> => ({ ok: true, stream }),
    dispose: () => {},
  }
}

/** 建 server + 发起「拿一块就断」的请求，返回服务端是否收尾。 */
async function abandonedRequest(
  router: Router,
  leak: { cancelled: () => boolean; enqueued: () => number },
): Promise<{ settled: boolean; closeSeen: boolean; enqueuedAfterSettle: number }> {
  let settled = false
  let closeSeen = false
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.on('close', () => { closeSeen = true })
      void router.chatCompletions(
        { model: 'sup,m1', stream: true, rawBody: body } as never,
        res as never,
      ).then(() => { settled = true }, () => { settled = true })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port

  await new Promise<void>((resolve) => {
    const creq = http.request({
      host: '127.0.0.1', port, path: '/x', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (cres) => {
      cres.once('data', () => { creq.destroy(); resolve() })
    })
    creq.on('error', () => resolve())
    creq.end(JSON.stringify({ model: 'sup,m1', messages: [{ role: 'user', content: 'hi' }], stream: true }))
  })

  await new Promise((r) => setTimeout(r, 1200))
  const enqueuedAfterSettle = leak.enqueued()
  server.closeAllConnections?.()
  server.close()
  return { settled, closeSeen, enqueuedAfterSettle }
}

test('客户端中途断开：服务端必须停手并 cancel 上游流（否则每放弃一次漏一条连接）', async () => {
  const leak = infiniteStream()
  const router = new Router('')
  router.add(supplierWith(leak.stream) as never)

  const { settled, closeSeen } = await abandonedRequest(router, leak)

  assert.equal(closeSeen, true, 'server 应看到客户端 close')
  assert.equal(settled, true, '客户端断开后请求处理必须收尾（不能永远挂着）')
  assert.equal(leak.cancelled(), true, '上游流必须被 cancel（否则 fetch body 泄漏，累积到 connection error）')

  // 断开后不能再继续消费上游
  const a = leak.enqueued()
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(leak.enqueued(), a, '断开后不该继续从上游拉数据')
})

test('客户端断开：上游流 cancel 链要穿过 tapStreamUsage / normalizeSSEStream 两层 wrapper', async () => {
  // 带 probe（= 真实请求路径）时会多包一层 tapStreamUsage；两层 wrapper 都必须
  // 实现 cancel→reader.cancel()，取消才到得了上游（缺一层就静默断链）。
  const leak = infiniteStream()
  const router = new Router('')
  router.add(supplierWith(leak.stream) as never)

  let settled = false
  let closeSeen = false
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.on('close', () => { closeSeen = true })
      void router.chatCompletions(
        { model: 'sup,m1', stream: true, rawBody: body } as never,
        res as never,
      ).then(() => { settled = true }, () => { settled = true })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => {
    const creq = http.request({
      host: '127.0.0.1', port, path: '/x', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (cres) => { cres.once('data', () => { creq.destroy(); resolve() }) })
    creq.on('error', () => resolve())
    creq.end(JSON.stringify({ model: 'sup,m1', messages: [{ role: 'user', content: 'hi' }], stream: true }))
  })
  await new Promise((r) => setTimeout(r, 1200))
  server.closeAllConnections?.()
  server.close()

  assert.equal(closeSeen, true)
  assert.equal(settled, true, '带探针的路径也必须收尾')
  assert.equal(leak.cancelled(), true, '取消必须穿过两层 wrapper 到达上游')
})

test('聚合失败：reader 必须被解绑（否则连接还活着时上层无法 cancel）', async () => {
  // 这一条测的**不是**「cancel 回调有没有触发」——那测不出东西：
  // 实测结论（两个都验过）：
  //   - 流 error 后调 cancel()，只会以同一错误 reject，**不触发** cancel 回调
  //     （`pull()` 抛错会把流置为 errored；上游拆连接则流直接 error）
  //   - 这两种情况下 undici **已经自己关了连接**，不需要我们 cancel
  // 所以聚合失败路径真正要保证的是 **reader 被解绑**：流锁着的话，上层
  // （writeChatResult 的失败路径 / 未来的取消逻辑）想 cancel 都会抛
  // `Invalid state: ReadableStream is locked`，连接就永久漏了。
  let releaseLocked = false
  const enc = new TextEncoder()
  const failing = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')) },
    pull() { throw new Error('aggregate read failed') },
  })
  const origGetReader = failing.getReader.bind(failing)
  ;(failing as unknown as { getReader: () => unknown }).getReader = () => {
    const r = origGetReader()
    const origRelease = r.releaseLock.bind(r)
    r.releaseLock = () => { releaseLocked = true; origRelease() }
    return r
  }

  const router = new Router('')
  router.add(supplierWith(failing) as never)
  const sink = {
    writeHead: () => undefined, end: () => undefined, write: () => true,
    once: () => undefined, removeListener: () => undefined, destroy: () => undefined,
    writableEnded: false, destroyed: false,
  } as never

  await router.chatCompletions(
    { model: 'sup,m1', stream: false, rawBody: JSON.stringify({ model: 'sup,m1', messages: [] }) } as never,
    sink,
  )
  await new Promise((r) => setTimeout(r, 150))

  assert.equal(releaseLocked, true, '聚合失败后必须 releaseLock，否则流锁死、上层无法回收')
  assert.equal(failing.locked, false, '流必须处于未锁定状态（可被 cancel / 已被回收）')
})
