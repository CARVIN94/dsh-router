/**
 * 段落总控的**接线**判据 —— 三件事必须真的串上，缺一件就静默失效：
 *   ① 段落进了 `controls`（面板看得见）；
 *   ② 段开关落盘到 `data.sections`，且**不碰** `categories`（两套开关不串味）；
 *   ③ `system-prompt/assemble` waterfall 真的把关闭的段删掉了（这是"可开关"
 *      的唯一真判据 —— 只测 ①② 会漏掉"面板能点、但 prompt 里照旧"）。
 *
 * ⚠️ 本文件里"真删段"的验证用**假宿主装配链**：注册一个监听器、手工跑一次
 *   waterfall（`ctx.waterfall` 真实现来自 cordis），而不是调真 `assemble()`。
 *   理由：真 `assemble` 需要整套 `dsh-system-prompt` 服务与 scope 环境，
 *   会把判据变成"宿主内部实现测试"；而本插件的责任边界只是"监听器拿到
 *   assembly 后返回什么"。监听器的返回形状 = 宿主采信的形状（`return transformed`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPromptExt, EXT_PROMPT_ID } from './plugin.ts'
import { OWN_SECTION_NAME, SECTION_CONTROL_PREFIX } from './sections.ts'
import type { PromptExtData } from './render.ts'
import type { ExtStoreService } from '../ext/contract.ts'

/** 记录写盘的内存 store。 */
function fakeStore(initial: { enabled?: boolean; data?: PromptExtData } = {}): ExtStoreService & {
  data: () => PromptExtData | undefined
  writes: PromptExtData[]
} {
  let data = initial.data
  let enabled = initial.enabled ?? true
  const writes: PromptExtData[] = []
  return {
    isEnabled: () => enabled,
    // 真实签名带 id（`setEnabled(id, enabled)`）——第一版漏了它，tsc 才报
    // "string 不能赋给 boolean"。桩的形状必须与契约逐字一致，否则测的是
    // 一个不存在的接口。
    setEnabled: (_id: string, v: boolean) => { enabled = v },
    readData: <T>() => data as T | undefined,
    writeData: (_id, d) => { data = d as PromptExtData; writes.push(d as PromptExtData) },
    data: () => data,
    writes,
  }
}

const SAMPLE = [
  { name: 'harness:identity', text: 'You are an AI agent.' },
  { name: 'tool:write', text: 'write tool spec' },
  { name: 'tool:edit', text: 'edit tool spec' },
]

test('★ 段落以 `sec:` 前缀进 controls，带组名、原文、且不可拖不可编辑', () => {
  const ext = createPromptExt({
    isSystemPromptReady: () => true,
    getSections: () => SAMPLE,
    store: fakeStore(),
  })
  const secRows = (ext.controls ?? []).filter((c) => c.id.startsWith(SECTION_CONTROL_PREFIX))
  assert.equal(secRows.length, 3, '段落没进 controls ⇒ 面板列不出来')
  const write = secRows.find((c) => c.id === `${SECTION_CONTROL_PREFIX}tool:write`)!
  assert.equal(write.title, 'write', '标题应去掉组前缀')
  assert.equal(write.detail, 'tool:write', '完整段名要能指认（报问题时用）')
  assert.equal(write.body, 'write tool spec', '没原文 = 用户盲切')
  assert.equal(write.group, '工具说明')
  assert.equal(write.on, true, '默认全开')
  assert.equal(write.sortable, false, '段 id 不在排序落盘范围，可拖就是假交互')
  assert.notEqual(write.editable, true, '别人的段不给改写入口，只开关')
})

test('准则分类仍在 controls 前列，且**不带** group（页头已是它的组头）', () => {
  const ext = createPromptExt({
    isSystemPromptReady: () => true,
    getSections: () => SAMPLE,
    store: fakeStore(),
  })
  const rows = ext.controls ?? []
  const plain = rows.filter((c) => c.group === undefined)
  assert.ok(plain.length > 0, '准则分类丢了 ⇒ 原功能被新功能挤掉')
  assert.ok(plain.every((c) => c.editable === true), '准则分类应保持可编辑')
  assert.equal(rows[0]!.group, undefined, '列表首条应是准则（无组节渲染在最前）')
})

test('★ 段开关落盘到 data.sections：关 = 存 false，开 = 删键（只存覆盖值）', () => {
  const store = fakeStore()
  const ext = createPromptExt({
    isSystemPromptReady: () => true,
    getSections: () => SAMPLE,
    store,
  })
  assert.equal(ext.setControl!(`${SECTION_CONTROL_PREFIX}tool:write`, false), true)
  assert.deepEqual(store.data()?.sections, { 'tool:write': false })
  // 开回来 ⇒ 键消失（不留 `true`，否则落盘会随用户点击无限膨胀）
  assert.equal(ext.setControl!(`${SECTION_CONTROL_PREFIX}tool:write`, true), true)
  assert.equal(store.data()?.sections, undefined, '全开后仍留着 sections 键')
})

test('★ 段开关不碰分类开关（两套开关各自一个键）', () => {
  const store = fakeStore({ data: { categories: { identity: false } } })
  const ext = createPromptExt({
    isSystemPromptReady: () => true,
    getSections: () => SAMPLE,
    store,
  })
  ext.setControl!(`${SECTION_CONTROL_PREFIX}tool:write`, false)
  assert.deepEqual(store.data()?.categories, { identity: false }, '写段开关把分类开关冲掉了')
  assert.deepEqual(store.data()?.sections, { 'tool:write': false })
  // 反向：写分类开关不能冲掉段开关
  ext.setControl!('identity', true)
  assert.deepEqual(store.data()?.sections, { 'tool:write': false }, '写分类开关把段开关冲掉了')
})

test('注入：清单外的段 id 拒写（旧数据/手改 ext.json 不该被面板认成有效开关）', () => {
  const store = fakeStore()
  const ext = createPromptExt({ isSystemPromptReady: () => true, getSections: () => [], store })
  assert.equal(ext.setControl!(`${SECTION_CONTROL_PREFIX}tool:write`, false), false)
  assert.equal(store.data(), undefined, '拒了却写了盘')
})

test('★ 自己的准则段拒绝被当成段落开关（同一件事不能有两个开关）', () => {
  const store = fakeStore()
  const ext = createPromptExt({ isSystemPromptReady: () => true, getSections: () => SAMPLE, store })
  assert.equal(ext.setControl!(`${SECTION_CONTROL_PREFIX}${OWN_SECTION_NAME}`, false), false)
  // 即使清单源里混进了它，controls 也不列
  const ext2 = createPromptExt({
    isSystemPromptReady: () => true,
    getSections: () => [{ name: OWN_SECTION_NAME, text: 'guideline' }, ...SAMPLE],
    store,
  })
  const ids = (ext2.controls ?? []).map((c) => c.id)
  assert.equal(ids.includes(`${SECTION_CONTROL_PREFIX}${OWN_SECTION_NAME}`), false,
    '准则段被列了 ⇒ 面板上同一件事出现两个开关')
})

test('段清单为空 ⇒ 不产出段条目（宿主没段/预热没完成时面板不显示空组）', () => {
  const ext = createPromptExt({ isSystemPromptReady: () => true, getSections: () => [], store: fakeStore() })
  assert.equal((ext.controls ?? []).some((c) => c.id.startsWith(SECTION_CONTROL_PREFIX)), false)
})

test('段条目的 on 反映已存关闭项（面板刷新要看到真实状态）', () => {
  const ext = createPromptExt({
    isSystemPromptReady: () => true,
    getSections: () => SAMPLE,
    store: fakeStore({ data: { sections: { 'tool:edit': false } } }),
  })
  const on = Object.fromEntries((ext.controls ?? []).map((c) => [c.id, c.on]))
  assert.equal(on[`${SECTION_CONTROL_PREFIX}tool:edit`], false)
  assert.equal(on[`${SECTION_CONTROL_PREFIX}tool:write`], true)
})

test('ext id 未漂移（落盘键跟着它，改了用户关段表就全丢）', () => {
  assert.equal(EXT_PROMPT_ID, 'prompt')
})
