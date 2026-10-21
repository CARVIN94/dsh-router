/**
 * 段落总控的**纯逻辑**判据（`sections.ts`）。
 *
 * 守三件事，每件都对着一种"静默失效"：
 *   ① 控制条 id 与段名的**往返**（编码错了 ⇒ 面板点的开关落到别人的段上）；
 *   ② 过滤**只删该删的**（自己那段恒放行、清单外的旧名字无害跳过）；
 *   ③ 分组的**归组与次序**（组的先后 = prompt 次序，不能被字母序打乱）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OWN_SECTION_NAME,
  SECTION_CONTROL_PREFIX,
  createSectionCache,
  disabledSectionNames,
  filterSections,
  groupLabelOf,
  groupSections,
  sectionControlId,
  sectionNameOf,
  sectionTitleOf,
} from './sections.ts'

test('控制条 id ↔ 段名往返（`sec:` 是传输层编码，落盘用裸名）', () => {
  assert.equal(sectionControlId('tool:write'), `${SECTION_CONTROL_PREFIX}tool:write`)
  assert.equal(sectionNameOf(sectionControlId('tool:write')), 'tool:write')
  // 含冒号的段名不能被"按第一个冒号切"吃掉后半截
  assert.equal(sectionNameOf(sectionControlId('mcp:my-server:tools')), 'mcp:my-server:tools')
})

test('非段条目（准则分类）不被当成段落 —— 否则分类开关会写到 segments 里', () => {
  assert.equal(sectionNameOf('identity'), null)
  assert.equal(sectionNameOf('cu-1'), null)
  assert.equal(sectionNameOf(''), null)
})

test('★ 只认显式 false：缺项 = 没碰过 = 开（与分类开关同一纪律）', () => {
  const off = disabledSectionNames({ sections: { 'tool:write': false, 'tool:read': true } })
  assert.equal(off.has('tool:write'), true)
  assert.equal(off.has('tool:read'), false, 'true 是"开着"，不该算进关闭集合')
  assert.equal(disabledSectionNames(undefined).size, 0, '没记录 = 全开')
  assert.equal(disabledSectionNames({}).size, 0)
})

test('★ 过滤只删关闭的段，且保持原序', () => {
  const all = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
  assert.deepEqual(filterSections(all, new Set(['b'])).map((s) => s.name), ['a', 'c'])
  assert.deepEqual(filterSections(all, new Set()).map((s) => s.name), ['a', 'b', 'c'])
})

test('★ 自己的准则段恒放行（它已有总开关+分类开关，不能再被段开关关一次）', () => {
  // 即使落盘里被写进了关闭项（手改 ext.json），也不许把它过滤掉
  const all = [{ name: OWN_SECTION_NAME }, { name: 'tool:write' }]
  const kept = filterSections(all, new Set([OWN_SECTION_NAME, 'tool:write']))
  // 准则段必须留下、被关的 tool:write 必须走 —— 两个方向都断言，
  // 只断"准则段在"的话，过滤器退化成"全都放行"也能过。
  assert.deepEqual(kept.map((s) => s.name), [OWN_SECTION_NAME],
    '准则段被过滤 ⇒ 分类开关全部看起来失效')
})

test('清单外的旧名字无害：宿主换版本后旧关闭项不该报错', () => {
  assert.doesNotThrow(() => filterSections([{ name: 'a' }], new Set(['gone:forever'])))
})

test('缓存：自己的段不进清单，且返回值是拷贝（调用方改不动缓存）', () => {
  const cache = createSectionCache()
  cache.update([{ name: OWN_SECTION_NAME, text: 'x' }, { name: 'tool:write', text: 'write spec' }])
  const list = cache.list()
  assert.deepEqual(list.map((e) => e.name), ['tool:write'], '准则段进了清单 ⇒ 面板多一个重复开关')
  list[0]!.text = 'mutated'
  assert.equal(cache.list()[0]!.text, 'write spec', 'list() 返回内部引用 ⇒ 面板改动污染后续读')
})

test('分组：组的先后 = 首次出现序（不按字母重排）', () => {
  const groups = groupSections([
    { name: 'deployment:persona-prefix', text: '' },
    { name: 'tool:bash', text: '' },
    { name: 'tool:edit', text: '' },
    { name: 'plan:policy', text: '' },
  ])
  assert.deepEqual(groups.map((g) => g.label), ['部署人设', '工具说明', '计划模式'])
  assert.deepEqual(groups[1]!.items.map((i) => i.name), ['tool:bash', 'tool:edit'], '组内顺序被改 ⇒ 面板顺序与 prompt 顺序脱钩')
})

test('★ 分组落名以真宿主实测为准（2026-10-21，9 个段名逐个钉）', () => {
  // 这组断言直接抄 3081 上真宿主返回的段名 —— 我第一版按"看起来像"的前缀
  // 脑补过两处（harness / app），真机一看就对不上。
  const actual: [string, string][] = [
    ['deployment:persona-prefix', '部署人设'],
    ['deployment:persona-suffix', '部署人设'],
    ['tool:pty', '工具说明'],
    ['tool:session-query', '工具说明'],
    ['mcp:rea', 'MCP 服务'],
    ['ui:deliverable-file-references', '界面与交付'],
    ['mcp-resource-servers', 'MCP 资源'],
    // ⚠️ 这两个**刻意不并入任何美名组**：`harness:source` 是运行环境说明
    // （不是开场身份），`app:web-surface` 是 Web GUI 说明（不是"界面与交付"，
    // 那个组是给 `ui:` 的）。归错组比留真实前缀更误导。
    ['harness:source', 'harness'],
    ['app:web-surface', 'app'],
  ]
  for (const [name, label] of actual) {
    assert.equal(groupLabelOf(name), label, `${name} 归组错了`)
  }
})

test('已知前缀用中文组名、未知前缀原样、无冒号归「其他」', () => {
  assert.equal(groupLabelOf('tool:write'), '工具说明')
  assert.equal(groupLabelOf('plan:policy'), '计划模式')
  // 宿主新加的段（映射表还没有）：组名原样显示，条目照样能列能开关
  assert.equal(groupLabelOf('web:surface'), 'web')
  assert.equal(groupLabelOf('unknown-thing'), '其他')
})

test('条目标题去掉组前缀（组名已经给了语境）', () => {
  assert.equal(sectionTitleOf('tool:write'), 'write')
  assert.equal(sectionTitleOf('mcp:my-server'), 'my-server')
  assert.equal(sectionTitleOf('mcp-resource-servers'), 'mcp-resource-servers', '无冒号时不能被切成空串')
})

test('空清单 ⇒ 空分组（不产出空壳组）', () => {
  assert.deepEqual(groupSections([]), [])
})
