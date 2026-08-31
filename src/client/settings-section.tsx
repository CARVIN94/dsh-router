/**
 * 「设置 → 路由系统」页 —— 走 DSH 官方 `settings.section` 座位。
 *
 * 容器几何（浏览器实测，不是估的）决定了这里的写法：
 *   - 内容宽 564px（面板 612 − 左右 padding 24）
 *   - **滚动归外壳** `.VOzbGW_options`（overflow-y:auto）：这里不能设
 *     height / overflow，否则跟外壳抢滚动、内容被裁
 *   - 根节点外面套了一层 `display: contents`，所以根节点没有自己的盒子
 *     —— 不能用 height:100% / flex:1 撑满那套写法
 *   - 横向会溢出：老布局是按整个中心栏宽做的，卡片 grid 必须按 564px 排
 *
 * 组件本身无状态、无 props：数据全在 RouterView 里自己 fetch。
 */
import { RouterView } from './RouterView.tsx'

/** 设置页入口组件。 */
export function RouterSettingsSection(): JSX.Element {
  // 不传 onBack：设置面板自带关闭，不需要「返回会话」
  return <RouterView />
}
