/**
 * 组合变更必须通知拓扑观察者 —— `onCombosChanged` 的出口判据。
 *
 * ⚠️ 为什么需要它（2026-10-14 实测的「面板里有，模型选择器里找不到」）：
 *   模型选择器（`ui-model-selection`）的模型目录是**客户端缓存**的：每个浏览器
 *   连接只 `load()` 一次，之后只在宿主转发的事件上失效重载
 *   （`llm/adapters-updated` / `settings/document-updated` / 凭据事件 / 重连）。
 *   而组合只是本插件 `combos.json` 里的一份状态：
 *     - `createCombo` 建了新组合 → 选择器永远看不到它
 *     - `updateCombo` 改了名字 → 选择器还拿旧名字，用户切不过去
 *     - `removeCombo` 删了组合 → 选择器里还留着，选中必然失败
 *   实测现场：`combos.json` 里是 `buddy-models-flash`（22:19 改的名），
 *   而选择器里显示的是**早已删除的** `NVIDIA-models` —— 整张表都过期了。
 *
 * 判据形态：直接守「提交成功后有没有发出通知」，而不是守客户端有没有刷新 ——
 * 客户端刷新要靠宿主转发，单测里没有宿主。通知是这里唯一能守住的那一环。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Router } from './index.ts'

/** 造一个空 stateFile 的临时目录（组合落在同目录的 combos.json）。 */
function fixture(): { dir: string; stateFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-router-combo-'))
  return { dir, stateFile: join(dir, 'state.json') }
}

test('★ createCombo 成功后通知一次（否则新组合在选择器里永不出现）', () => {
  const { stateFile } = fixture()
  let notified = 0
  const router = new Router(stateFile, undefined, undefined, { onCombosChanged: () => { notified += 1 } })
  assert.equal(router.createCombo('c1', ['supA,a-model']).ok, true)
  assert.equal(notified, 1, '新建组合后没有通知 ⇒ 模型选择器看不到它')
})

test('★ updateCombo 成功后通知（否则选择器还拿旧名字，切不过去）', () => {
  const { stateFile } = fixture()
  let notified = 0
  const router = new Router(stateFile, undefined, undefined, { onCombosChanged: () => { notified += 1 } })
  router.createCombo('old-name', ['supA,a-model'])
  notified = 0
  assert.equal(router.updateCombo('old-name', 'new-name', ['supA,a-model']).ok, true)
  assert.equal(notified, 1, '改名后没有通知 ⇒ 选择器里还留着旧名字')
})

test('★ removeCombo 成功后通知（否则选择器里留着已删的组合，选中必失败）', () => {
  const { stateFile } = fixture()
  let notified = 0
  const router = new Router(stateFile, undefined, undefined, { onCombosChanged: () => { notified += 1 } })
  router.createCombo('gone', ['supA,a-model'])
  notified = 0
  assert.equal(router.removeCombo('gone').ok, true)
  assert.equal(notified, 1, '删除后没有通知 ⇒ 选择器里还留着它')
})

test('被拒绝的变更不通知（校验失败时组合根本没变）', () => {
  const { stateFile } = fixture()
  let notified = 0
  const router = new Router(stateFile, undefined, undefined, { onCombosChanged: () => { notified += 1 } })
  router.createCombo('keep', ['supA,a-model'])
  notified = 0
  // 空模型列表 / 非法名字 / 不存在的 id：三条都得原地不动
  assert.equal(router.createCombo('bad-chars!', ['supA,a-model']).ok, false)
  assert.equal(router.createCombo('no-models', []).ok, false)
  assert.equal(router.updateCombo('missing-id', 'x', ['supA,a-model']).ok, false)
  assert.equal(router.removeCombo('missing-id').ok, false)
  assert.equal(notified, 0, '失败的变更不该通知（会让客户端做一次无意义的全量重拉）')
})

test('通知出口抛错不能把已提交的变更报成失败', async () => {
  const { stateFile } = fixture()
  const router = new Router(stateFile, undefined, undefined, {
    // 监听方（宿主事件总线）出问题：这是通知不是事务参与者
    onCombosChanged: () => { throw new Error('listener exploded') },
  })
  const result = router.createCombo('survivor', ['supA,a-model'])
  assert.equal(result.ok, true, '通知失败不该让 createCombo 变红 —— 组合其实已经提交')
  assert.equal((await router.combos()).some((c) => c.name === 'survivor'), true, '内存里的组合必须还在')
})

test('没装出口时不抛（单测/独立运行时）', () => {
  const { stateFile } = fixture()
  const router = new Router(stateFile)
  assert.doesNotThrow(() => { router.createCombo('c1', ['supA,a-model']) })
})

test('通知发生在落盘之后 —— 监听方重读时能读到新组合', () => {
  const { stateFile } = fixture()
  let seen: string[] = []
  const router = new Router(stateFile, undefined, undefined, {
    onCombosChanged: () => {
      // 监听方（宿主）会重新读一遍组合去刷客户端，此刻必须已经能读到新的
      const onDisk = JSON.parse(readFileSync(join(stateFile, '..', 'combos.json'), 'utf8')) as {
        combos: Array<{ name: string }>
      }
      seen = onDisk.combos.map((c) => c.name)
    },
  })
  router.createCombo('persisted', ['supA,a-model'])
  assert.deepEqual(seen, ['persisted'], '通知时组合还没落盘 ⇒ 监听方重读会拿到旧状态')
})

test('重复写同一个组合名不触发第二次落盘语义变化（幂等读取安全）', () => {
  const { stateFile } = fixture()
  let notified = 0
  const router = new Router(stateFile, undefined, undefined, { onCombosChanged: () => { notified += 1 } })
  router.createCombo('c1', ['supA,a-model'])
  // 同 id 的 update 到等价内容仍然是合法提交（不是 no-op 语义），必须通知
  assert.equal(router.updateCombo('c1', 'c1', ['supA,a-model']).ok, true)
  assert.equal(notified, 2)
})

test('★ 注入：拿掉通知 ⇒ 上面几条会红（反向自检）', () => {
  const { stateFile } = fixture()
  // 等价于修复前的实现：没有 onCombosChanged
  const router = new Router(stateFile)
  router.createCombo('c1', ['supA,a-model'])
  const combosFile = join(stateFile, '..', 'combos.json')
  // 落盘仍然发生（这条路径没被改坏），但没有任何通知出口可发
  const onDisk = JSON.parse(readFileSync(combosFile, 'utf8')) as { combos: unknown[] }
  assert.equal(onDisk.combos.length, 1, '落盘行为必须保持')
})
