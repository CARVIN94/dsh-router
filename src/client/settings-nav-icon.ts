/**
 * 给设置导航里「路由」这一行换掉宿主的默认齿轮。
 *
 * 为什么需要这个：DSH 0.1.x 的 `settings.section` 注册**只认 id / order / label
 * 三个字段**，图标是宿主内部按「内置 id 白名单」选的，插件传不了。所以外部
 * section 一律拿到通用齿轮（跟「通用设置」「远程访问」同一个）。
 * 在契约长出 icon 字段之前，只能注册后认领自己的那一行。
 *
 * 做法跟 dsh-better-sidebar 的 settings-nav-icon.ts 一致：给自己的行打一个
 * 属性标记，再由 CSS 用 mask 渲染图标（见 router.css 的
 * `[data-dsh-router-settings-nav]`）。用 mask + currentColor 是为了跟随
 * 宿主导航的 hover/active 配色，也保持 16px 的图标节奏。
 *
 * 匹配方式：按行的**可见文案**认领（label 可能本地化），且只认 `nav button`，
 * 碰到同名的别人家 section 不会误伤（我们同时校验它确实在设置面板里）。
 * 卸载时断开观察并摘掉标记，HMR / 插件热卸载安全。
 */

/** 打在设置导航按钮上的标记属性。 */
export const SETTINGS_NAV_MARKER = 'data-dsh-router-settings-nav'

/** 设置面板的导航按钮选择器（宿主结构：dialog 里的 nav）。 */
const NAV_BUTTON_SELECTOR = '[role="dialog"] nav button'

/**
 * 持续把标记打在文案等于 `label` 的那一行的身上。
 * @param label 当前本地化的 section 标题（跟注册时的 label 一致）
 * @returns 清理函数：断开观察 + 摘掉所有本插件打的标记
 */
export function registerSettingsNavIcon(label: string): () => void {
  let disposed = false
  const wanted = label.trim()

  const sync = (): void => {
    if (disposed || wanted === '') return
    for (const button of document.querySelectorAll<HTMLElement>(NAV_BUTTON_SELECTOR)) {
      const matches = button.textContent?.trim() === wanted
      if (matches) button.setAttribute(SETTINGS_NAV_MARKER, '')
      else button.removeAttribute(SETTINGS_NAV_MARKER)
    }
  }

  sync()
  // 设置面板是按需挂载的：body 子树变动时重新认领
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return () => {
    disposed = true
    observer.disconnect()
    for (const el of document.querySelectorAll(`[${SETTINGS_NAV_MARKER}]`)) {
      el.removeAttribute(SETTINGS_NAV_MARKER)
    }
  }
}
