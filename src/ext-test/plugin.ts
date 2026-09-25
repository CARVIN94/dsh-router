/**
 * 连接自检扩展（`router.ext` 侧的实现）—— 声明与状态都在这里，**不做任何拦截**。
 *
 * 它和 rtk 那类扩展的区别要写清楚：本扩展**不挂任何监听、不改写任何命令**，
 * 唯一作用是让用户在官方插件页里打开一块自检面板（选供应商 / 模型 / 连接，跑一次
 * 真实的访问测试并看到底报了什么）。所以它复用 `router.ext` 这条通道只是为了拿到
 * **发现 + 开关**两件事，而不是为了拦截。
 *
 * 面板本身在浏览器侧（`src/client/ExtTestPanel.tsx`），通过原生行的
 * `plugins.row.config` 座位挂在「包含的组件」里那一行的详情页上；这里只负责让它在
 * 列表里有个身份、以及报出运行时就绪状态。
 */
import type { RouterExt } from '../ext/contract.ts'

/** 扩展开关表里的注册键（也是 URL 面板读它的 id）。 */
export const EXT_TEST_ID = 'test'

/**
 * 构造这个扩展器。
 *
 * `getState()` 恒为就绪：自检能力不依赖外部二进制（不像 rtk 需要本机装 rtk），
 * 「能不能测」取决于用户选的供应商/模型/连接，不该由扩展提前否决 —— 真跑一次
 * 才知道，那时错误信息比一个「未就绪」有用得多。
 */
export function createTestExt(): RouterExt {
  return {
    id: EXT_TEST_ID,
    name: '连接自检',
    description: '选供应商、模型与连接，跑一次真实访问测试，看连接是否可用或报什么错',
    // 随核心分发 -> 插件页的原生「包含的组件」里有它一行，自绘节里不再重复列。
    source: 'builtin' as const,
    getState: () => ({ ready: true }),
  }
}
