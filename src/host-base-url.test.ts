/**
 * 网关端点按**宿主实际监听端口**解析 —— issue #9 的闸门。
 *
 * ## 这条闸门拦的是什么
 *
 * `/v1/*` 是注册在**宿主** webServer 上的路由，端口由启动通道给：`dsh web` 默认
 * 3080，桌面端官方通道、以及 `port: 0`（OS 分配）都不是。adapter 曾把
 * `http://localhost:3080/v1` 写死，于是那些宿主上 Router 每一轮对话都是
 * `dsh-router upstream call failed: fetch failed`，而 `/v1` 明明就在本机跑着。
 *
 * 判据刻意用**真服务器 + OS 分配端口**而不是打桩 fetch：打桩只能证明字符串拼对了，
 * 证明不了「非 3080 端口上请求真的落得到」（这正是当初漏掉这条 bug 的原因）。
 * `listen(0)` 拿到的端口几乎不可能是 3080，于是「用 3080 也能过」的假修法在这条
 * 闸门下会当场变红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RouterAdapter } from './llm/adapter.ts'
import { loopbackBaseURL } from './host-base-url.ts'

/** 起一个只回一条最小 SSE 的真服务器，回报 OS 分配的端口与收到的路径。 */
async function serveSse(): Promise<{ port: number; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { port, hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** 跑完一次 adapter 流，返回收到的块类型。 */
async function drain(adapter: RouterAdapter): Promise<string[]> {
  const types: string[] = []
  for await (const c of adapter.stream({ model: 'm', messages: [], signal: AbortSignal.timeout(5000) } as never)) {
    types.push(c.type)
  }
  return types
}

test('端点：宿主端口不是 3080 时，请求照样落得到（issue #9 的原始现场）', async () => {
  const up = await serveSse()
  try {
    assert.notEqual(up.port, 3080, '这条用例的判据就是「端口不是 3080」')
    const adapter = new RouterAdapter(loopbackBaseURL(() => up.port), { comboModels: async () => [] })
    const types = await drain(adapter)
    assert.deepEqual(up.hits, ['/v1/chat/completions'], `请求应打到宿主 /v1，实际打到：${JSON.stringify(up.hits)}`)
    assert.ok(types.includes('text-delta'), `应真的收到上游内容，实际块类型：${JSON.stringify(types)}`)
  } finally {
    await up.close()
  }
})

test('端点：端口每次请求现算（listen 前读不到、宿主重启换端口都不缓存）', async () => {
  const first = await serveSse()
  const second = await serveSse()
  try {
    let port: number | undefined = first.port
    let reads = 0
    const adapter = new RouterAdapter(
      loopbackBaseURL(() => {
        reads += 1
        return port
      }),
      { comboModels: async () => [] },
    )
    await drain(adapter)
    port = second.port // 宿主换了端口（重启 / 重新 listen）
    await drain(adapter)
    assert.deepEqual(first.hits, ['/v1/chat/completions'], '第一次应打在第一个端口')
    assert.deepEqual(second.hits, ['/v1/chat/completions'], '端口变了之后应改打新端口（不能缓存第一次的值）')
    assert.ok(reads >= 2, `端口应每请求现读，实际只读了 ${reads} 次`)
  } finally {
    await first.close()
    await second.close()
  }
})

test('端点：端口读不到时报出原因，不回退 3080 硬猜', async () => {
  const adapter = new RouterAdapter(loopbackBaseURL(() => undefined), { comboModels: async () => [] })
  await assert.rejects(
    () => drain(adapter),
    (err: Error) => {
      assert.match(err.message, /webServer/, `报错必须带原因，实际：${err.message}`)
      assert.equal((err as { code?: string }).code, 'TRANSPORT', '应是可重试的传输类错误')
      return true
    },
  )
})

test('端点：常量形态的 baseURL 仍然可用（测试与显式传入的老调用方）', () => {
  assert.equal(loopbackBaseURL(() => 19387)(), 'http://127.0.0.1:19387/v1')
})

test('源码：非测试代码里不得再出现写死的 3080 端点', () => {
  // 防复发闸门：这次的根因就是一行写死的字符串，只靠「端口现算」的实现测试拦不住
  // 将来有人在别处再写一遍。判据只看**代码**（先剥掉注释）——注释里可以、也应该
  // 写明「当年就是这里写死了 3080」。
  const root = fileURLToPath(new URL('.', import.meta.url))
  const offenders: string[] = []
  for (const file of walk(root)) {
    if (/(?:localhost|127\.0\.0\.1):3080/.test(stripComments(readFileSync(file, 'utf8')))) {
      offenders.push(file.slice(root.length))
    }
  }
  assert.deepEqual(offenders, [], `这些文件里还有写死的 3080 端点（宿主端口随启动通道变）：${offenders.join(', ')}`)
})

/** 去掉块注释与行注释，只留可执行代码。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 递归列出 src 下的 .ts 文件（跳过测试自身：测试里出现端口字面量是合法的）。 */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`
    if (entry.isDirectory()) out.push(...walk(`${path}/`))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path)
  }
  return out
}
