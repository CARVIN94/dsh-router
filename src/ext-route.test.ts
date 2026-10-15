/**
 * `/router/api/ext` 路由的**出口判据**。
 *
 * ⚠️ 为什么需要它（2026-09-30 实测的「扩展一直加载中、然后卡死」）：
 *   我重构 op 分支时以为「成功路径统一落到末尾响应」，把 GET 的
 *   `writeJson(res, 200, {ok:true, enhancers:list})` 删了 —— 结果**没有任何地方
 *   写响应** ⇒ 请求永不结束 ⇒ 面板一直转圈。
 *
 *   ⚠️ **它躲过了全部现有闸门**：typecheck 通过（`writeJson` 少调一次不是类型错误）、
 *   387 条单测全绿（没有一条从 HTTP 入口打过这个路由）、build 通过。
 *   典型的「绕过入口的验证 = 没验入口」—— 判据全在函数级，缺一条**路由级**的。
 *
 * 做法：不启真服务器，直接读源码断言**每个 return 之前都有出口**这种形状 ——
 * 太脆。改为**结构判据**：GET 与 PATCH 两条成功路径都必须能走到 `writeJson`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

/** 取出 `/ext` 路由的整段源码。 */
function extRouteBody(): string {
  const start = src.indexOf('route(`${ROUTER_API_BASE}/ext`')
  assert.ok(start > 0, '找不到 /ext 路由')
  // 到下一个 `route(` 之前
  const next = src.indexOf('\n  route(', start + 10)
  return src.slice(start, next > 0 ? next : start + 4000)
}

test('★ /ext 路由必须有 GET 的响应出口（少写一次 = 请求永不结束）', () => {
  const body = extRouteBody()
  const writes = body.match(/writeJson\(res, 2\d\d/g) ?? []
  assert.ok(writes.length >= 1,
    '/ext 路由里一处 writeJson 都没有 ⇒ 请求永不返回（面板一直"加载中"）')
  // GET 成功路径：算完 list 之后必须写出
  const listLine = body.indexOf('const list: ExtInfo[]')
  assert.ok(listLine > 0, '找不到 GET 的 list 计算')
  const after = body.slice(listLine)
  // ⚠️ 窗口取 600 而非 200：出口上方有 5 行注释，窗口太窄会**误判成缺失**
  //   （我第一版 200 就红了，而代码是好的 —— 又一次「判据比被守的东西严」）。
  assert.match(after.slice(0, 600), /writeJson\(res,\s*200/,
    'GET 算完 list 之后没有 writeJson ⇒ 响应不出口')
})

test('★ op 成功路径也必须带 enhancers（客户端靠它刷新）', () => {
  const body = extRouteBody()
  // op 块里那处：两侧都带 enhancers
  const opWrites = body.match(/writeJson\(res,\s*200,\s*addedId[^)]*enhancers/g) ?? []
  assert.ok(opWrites.length >= 1, 'op 成功没有回 enhancers ⇒ 增删改后界面停在旧状态')
})

test('注入：删掉 GET 的 writeJson ⇒ 本判据会红', () => {
  // 反向自检：把出口拿掉，上面那条必须不成立。
  const stripped = extRouteBody().replace(
    /writeJson\(res,\s*200,\s*\{\s*ok:\s*true,\s*enhancers:\s*list\s*\}\)/,
    '/* removed */',
  )
  const after = stripped.slice(stripped.indexOf('const list: ExtInfo[]'))
  assert.doesNotMatch(after.slice(0, 600), /writeJson\(res,\s*200/,
    '注入没生效：这个替换匹配不上（判据会静默全绿）')
})

// ── 源码目录的野文件（2026-09-30 实测：`.bak` 被提交进仓）────────
test('★ src 下不许有备份/临时文件（它们会被 `git add -A` 顺手带进仓）', () => {
  // ⚠️ 实测经过：我用 `sed -i.bak` 做注入验证，备份文件 `content.ts.bak`
  //   **被 `git add src/ext-prompt/` 带进了提交**。
  //   它没被任何代码引用（`.bak` 后缀），所以**测试、typecheck、build 全绿** ——
  //   典型的「产物看起来对、仓里却多了一份东西」。
  //   而且它危险在：下一个人看到 `content.ts.bak` 会以为是**第二份内容**，
  //   正是准则里「反查重复：新旧成两份」要防的。
  //
  // `check-publish` 只管「patch / exports / files 白名单 / 源码清单」的一致性，
  // **不管源码目录里的野文件** ⇒ 这里补上。
  const junk = [...readdirSync(new URL('.', import.meta.url), { recursive: true } as never) as string[]]
    .filter((f) => /\.(bak|orig|rej|tmp|swp)$/.test(f) || /~$/.test(f))
  assert.deepEqual(junk, [], `源码目录里有临时/备份文件：${junk.join(', ')}`)
})
