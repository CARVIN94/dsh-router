/**
 * 「设置 → 路由」页 —— 走 DSH 官方 `settings.section` 座位。
 *
 * 容器几何（浏览器实测，不是估的）决定了这里的写法：
 *   - 内容宽 564px（面板 612 − 左右 padding 24）
 *   - 外壳 `.VOzbGW_options` 是 `overflow-y:auto` 且高度确定，所以**根节点
 *     限高**（`height:100%`）+ 内容区自己滚，才能做到「tab 条固定、只有
 *     内容区滚」。不限高就会退化成整页滚，tab 条跟着滚上去
 *   - 根节点外面套了一层 `display: contents`（宿主 slot renderer 给的），
 *     但实测 `height:100%` 能穿过它解析到外壳高度
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
