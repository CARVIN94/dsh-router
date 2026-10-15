/**
 * 首字节预算测试 —— 组合的一条腿「连上了、200 了、就是不吐字节」时必须降级。
 *
 * 2026-09-24 夜里的现场（usage.json / 三个 session 的 step 时间线互相对齐）：
 * money 组合第一腿 codebuddy-en 卡住，ttfb 分别 84s / 122s / 151s / 244s / 246s /
 * 250s / 254s / 255s，**8 次全部 ok: true**——全都最终成功了，只是晚了四分钟。
 * 用户干等 200 多秒手动暂停。
 *
 * 为什么以前不会降级：停滞既不是成功也不是失败，所以
 *   - 插件的 120s 只守「连接 + 响应头」（fetch 一返回就撤表），守不到 body
 *   - 核心写响应的路径没有计时器，组合链卡在这一条腿上一动不动
 *   - 该号也不会被冷却（没失败 → noteFailure 不触发）→ 下次还挑它
 *
 * 这里守的是修复后的语义：**预算到就判失败，链往前走**。没装这个闸门时
 * 下面两条测试都会在 5s 的看门狗里超时变红（而不是把测试进程挂死）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { Router, withFirstByteDeadline } from './index.ts'
import { AccountPool } from './account-pool.ts'
import type { ModelInfo } from './types.ts'
import type { AccountPool as Pool } from './account-pool.ts'
import type { ChatOnceResult, SupplierAccountNow, SupplierStatusNow } from '../suppliers/contract.ts'

const enc = new TextEncoder()

/** 永不吐字节的流（模拟「200 响应头到手，body 停摆」），记录有没有被 cancel。 */
function stallingStream(): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    cancel() { cancelled = true },
  })
  return { stream, cancelled: () => cancelled }
}

/** 立刻吐一帧 + [DONE] 的正常流。 */
function healthyStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`))
      ctrl.enqueue(enc.encode('data: [DONE]\n\n'))
      ctrl.close()
    },
  })
}

function supplier(id: string, uids: string[], chatOnce: (uid: string) => Promise<ChatOnceResult>) {
  const accounts: SupplierAccountNow[] = uids.map((uid) => ({ uid, credits: 0, state: 'ok' as const }))
  return {
    id, name: id, priority: 0, pool: new AccountPool(id) as Pool,
    status: (): SupplierStatusNow => ({ id, name: id, accounts }),
    listModels: async (): Promise<ModelInfo[]> => [{ id: 'm1' }],
    getAlias: () => id,
    accounts: () => accounts,
    chatOnce,
    dispose: () => {},
  }
}

function captureRes(): { res: ServerResponse; body: () => string } {
  const chunks: string[] = []
  const text = (chunk: unknown): string =>
    chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : String(chunk)
  const res = {
    writableEnded: false,
    destroyed: false,
    writeHead: (): unknown => undefined,
    write: (chunk?: unknown): boolean => { chunks.push(text(chunk)); return true },
    end: (chunk?: unknown): unknown => { if (chunk !== undefined) chunks.push(text(chunk)); return undefined },
    once: (): unknown => undefined,
    removeListener: (): unknown => undefined,
    destroy: (): unknown => undefined,
  } as unknown as ServerResponse
  return { res, body: () => chunks.join('') }
}

const req = {
  model: 'c',
  stream: true,
  rawBody: JSON.stringify({ model: 'c', messages: [{ role: 'user', content: 'hi' }], stream: true }),
}

/** 给等待加看门狗：闸门没装时这里是 5s 超时（红），而不是把测试挂死。 */
async function within<T>(ms: number, run: () => Promise<T>): Promise<T> {
  return await Promise.race([
    run(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`组合 ${ms}ms 内没有降级`)), ms)),
  ])
}

test('第一腿停滞：预算到就判失败，落到下一条腿（而不是把请求挂到客户端自己放弃）', async () => {
  const stall = stallingStream()
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: 150 })
  router.add(supplier('supA', ['a1'], async () => ({ ok: true, stream: stall.stream })) as never)
  router.add(supplier('supB', ['b1'], async () => ({ ok: true, stream: healthyStream('ok-from-B') })) as never)
  assert.equal(router.createCombo('c', ['supA,m1', 'supB,m1']).ok, true)

  const { res, body } = captureRes()
  const t0 = Date.now()
  await within(5_000, () => router.chatCompletions(req, res))
  const elapsed = Date.now() - t0

  assert.match(body(), /ok-from-B/, '必须由第二条腿服务（第一腿 200 了但不吐字节）')
  assert.equal(stall.cancelled(), true, '停滞的上游流必须被 cancel，否则连接原样挂着')
  // 2s 是组合「喘口气」等待（TRANSIENT_SETTLE_MS）——停滞按 transport 归类，
  // 该等就得等；这里断言它确实走了「失败→降级」这条路，而不是瞬间成功。
  assert.ok(elapsed >= 2_000, `应先等喘口气窗口再降级，实际 ${elapsed}ms`)
  assert.ok(elapsed < 5_000, `降级必须发生在预算+喘口气附近，实际 ${elapsed}ms`)
})

test('预算是「每条腿」一份：腿内第二个号不再各等一次（否则 60s × 号数）', async () => {
  const stallA1 = stallingStream()
  const stallA2 = stallingStream()
  let a1 = 0
  let a2 = 0
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: 150 })
  router.add(supplier('supA', ['a1', 'a2'], async (uid) => {
    if (uid === 'a1') { a1 += 1; return { ok: true, stream: stallA1.stream } }
    a2 += 1
    return { ok: true, stream: stallA2.stream }
  }) as never)
  router.add(supplier('supB', ['b1'], async () => ({ ok: true, stream: healthyStream('ok-from-B') })) as never)
  assert.equal(router.createCombo('c', ['supA,m1', 'supB,m1']).ok, true)

  const { res, body } = captureRes()
  const t0 = Date.now()
  await within(5_000, () => router.chatCompletions(req, res))
  const elapsed = Date.now() - t0

  assert.match(body(), /ok-from-B/)
  assert.equal(a1, 1, '第一个号被调了一次')
  assert.equal(a2, 0, '预算已耗尽：同一个号池里的第二个号不该再各等 150ms（停滞是上游级的）')
  assert.ok(elapsed < 5_000, `不能按号数翻倍地等，实际 ${elapsed}ms`)
})

test('wrapper：第一个字节到手后不再计时（长生成不能被砍）', async () => {
  let ctrlRef: ReadableStreamDefaultController<Uint8Array> | undefined
  const src = new ReadableStream<Uint8Array>({ start: (c) => { ctrlRef = c } })
  const reader = withFirstByteDeadline(src, 60).getReader()

  ctrlRef?.enqueue(enc.encode('first'))
  assert.equal(dec((await reader.read()).value!), 'first')
  // 停 3 倍预算才吐第二块：过了截止点也必须原样透传
  await new Promise((r) => setTimeout(r, 200))
  ctrlRef?.enqueue(enc.encode('second'))
  assert.equal(dec((await reader.read()).value!), 'second')
  await reader.cancel()
})

test('wrapper：源流一个字节都不吐就到期 → 流判失败（上层据此换号/换模型）', async () => {
  const { stream, cancelled } = stallingStream()
  const reader = withFirstByteDeadline(stream, 60).getReader()
  await assert.rejects(() => reader.read(), /no first byte within 60ms/)
  assert.equal(cancelled(), true, '到期时必须把取消传给源流（否则上游连接原样挂着）')
})

function dec(v: Uint8Array): string {
  return new TextDecoder().decode(v)
}
