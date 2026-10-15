/**
 * 设置-模型 → Router 卡片：把宿主那句走不通的提示换成正确说法。
 *
 * 为什么不能直接改源头：Router 的卡片走宿主的 "unknown" 布局（宿主只认得
 * llm-deepseek / llm-pi-ai 两套表单），那句
 *   「其余字段在 settings.yaml 中，请直接编辑对应段。 (dsh-router)」
 * 属于宿主 `settings.models` 的 locale 字典，而字典注册对同一个 (ns, locale)
 * 只允许一个占位者（重复注册直接抛），插件覆写不了，契约也没给可覆写字段。
 * 所以沿用本插件既有的认领手法（同 settings-nav-icon.ts）：按文案指纹认出宿主
 * 渲染的那一段，就地改写。
 *
 * 只写 `nodeValue`、不增删节点（节点归 React，摘掉会让它的引用落空）。React 重渲染
 * 覆盖回来时观察器会再改一次；已是目标文案就早退，不会自激。
 *
 * 升级路径：宿主若给该提示长出可覆写字段（或 Router 有了专属布局），删掉本文件。
 */

/** 指纹：语言无关（不受中英文切换影响），且只出现在 Router 卡片上。 */
const FINGERPRINT = '(dsh-router)'

/** 正确说法：对齐 README「组合即模型」。 */
export const ROUTER_MODEL_HINT_COPY = '组合即模型 · 建好的组合会自动出现在 DSH 模型目录中，选中组合名即可直接使用。'

/**
 * 这段文本要不要改写。
 * @param text 段落当前文本
 * @returns 需要改写时给出目标文案，否则 undefined
 */
export function routerHintRewrite(text: string): string | undefined {
  if (!text.includes(FINGERPRINT)) return undefined
  if (text === ROUTER_MODEL_HINT_COPY) return undefined // 已改过，早退防自激
  return ROUTER_MODEL_HINT_COPY
}

/**
 * 持续把 Router 卡片里的宿主提示改写成 {@link ROUTER_MODEL_HINT_COPY}。
 * @returns 清理函数：断开观察
 */
export function rewriteRouterModelHint(): () => void {
  const sync = (): void => {
    for (const el of document.querySelectorAll<HTMLElement>('p[class*="advancedHint"]')) {
      const next = routerHintRewrite(el.textContent ?? '')
      // 宿主把整句渲染成一个文本节点（单个模板串）——直接整段替换
      const node = el.firstChild
      if (next === undefined || node?.nodeType !== Node.TEXT_NODE) continue
      node.nodeValue = next
    }
  }

  sync()
  // 设置面板按需挂载、React 重渲染都会覆盖回去，子树变动时重新认领
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}
