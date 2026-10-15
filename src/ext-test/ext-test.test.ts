/**
 * 插件自检扩展（`router.ext` 侧）测试 —— 锁住三件事：
 *   1. 登记进 `router.ext` 表，带上可显示的身份（名字/说明/就绪）；
 *   2. **幂等**：同一个 id 已在表里就不顶掉别人的登记；
 *   3. 恒为就绪 —— 自检能力不依赖外部二进制，不该提前否决（真跑一次才知道）。
 *
 * 为什么测这个：扩展的「卡片出现与否」完全取决于它在不在这张表里，而表是核心
 * provide 的**同一个 live 对象**。登记没发生的话，面板与插件页都看不到它，且不报错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestExt, EXT_TEST_ID } from './plugin.ts'
import { apply, name as CORDIS_NAME } from './index.ts'
import type { RouterExtService } from '../ext/contract.ts'

test('扩展器带上面板要用的身份，且恒为就绪', () => {
  const ext = createTestExt()
  assert.equal(ext.id, EXT_TEST_ID)
  assert.equal(ext.name, '插件自检')
  assert.ok((ext.description ?? '').length > 0, '没有说明，插件页那一行就没有副标题')
  assert.equal(ext.getState().ready, true, '自检不依赖本机二进制，不该报未就绪')
})

test('cordis 身份是行 id（与 patch 里声明的逐字相同，否则 loader 认不出）', () => {
  assert.equal(CORDIS_NAME, 'dsh-router-ext-test')
})

/** 最小 ctx：inject 立刻回调、emit 记下来。 */
function fakeCtx(table: RouterExtService): {
  ctx: Parameters<typeof apply>[0]
  events: string[]
} {
  const events: string[] = []
  return {
    events,
    ctx: {
      inject: (deps: string[], cb: (sctx: unknown) => void) => {
        cb({ get: (key: string) => (key === 'router.ext' ? table : undefined) })
      },
      emit: (event: string) => { events.push(event) },
    } as unknown as Parameters<typeof apply>[0],
  }
}

test('apply 把扩展登记进 router.ext 表（这张表就是「卡片出现」的唯一依据）', () => {
  const table: RouterExtService = {}
  const { ctx, events } = fakeCtx(table)
  apply(ctx)
  assert.equal(table[EXT_TEST_ID]?.name, '插件自检')
  assert.deepEqual(events, [], '核心持有同一个 live 对象且每次请求现读，不需要广播事件')
})

test('幂等：同一个 id 已在表里时不顶掉别人的登记', () => {
  const table: RouterExtService = {}
  const { ctx } = fakeCtx(table)
  apply(ctx)
  const first = table[EXT_TEST_ID]
  apply(ctx)
  assert.equal(table[EXT_TEST_ID], first, '重复登记不该换成一个新对象')
})
