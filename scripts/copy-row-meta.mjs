/**
 * 把每一**行**（插件页原生「包含的组件」里的一行）的自描述资源拷到 `lib/<子路径>/`。
 *
 * 为什么需要这一步：宿主的插件页按**模块说明符的子路径**读行的显示信息 ——
 * `dsh-router-core/suppliers/nvidia/locale/zh.json` 与
 * `.../suppliers/nvidia/package.json`（`readPluginMeta` 用完整说明符解析资源，
 * 不是只取包名）。这些文件得跟着 js 一起发布，而 tsdown 只产 js。
 *
 * 行的判定：**含 `row.json` 的目录**（那是行独有的清单文件）。以它为准而不是
 * 「src/suppliers 下的目录」—— 否则新增 `src/ext-test` 这种不在 suppliers 下的行
 * 会被静默漏掉，本脚本成功、产物却没有它的显示信息（症状：行在页面上，标题退化成
 * 模块说明符，且**构建不报错**）。这正是 check-publish 里同一条规则的由来。
 *
 * 三个刻意的形状：
 *   1. 源码里那份叫 **`row.json`** 而不是 `package.json`：子目录里放
 *      `package.json` 会让 rolldown 把那个目录当**包边界**，于是
 *      `src/<子路径>/index.ts` 这个入口解析失败（实测报 `UNRESOLVED_ENTRY`）。
 *      所以清单在源码里换个名字，**拷出去时改回** `package.json` —— 宿主只认后者。
 *   2. 复制而不是移动：源文件必须留着，下一次构建的 check-publish 还要查它。
 *   3. 少拷一个的后果是**静默**的，所以这件事由 check-publish 盯着（缺文件直接变红）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const srcRoot = join(root, 'src')

/** 找出所有「行」：含 row.json 的目录，键是相对 src 的子路径。 */
function findRows(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sub = relative(srcRoot, join(dir, entry.name))
    if (existsSync(join(dir, entry.name, 'row.json'))) out.push(sub)
    // 递归一层：行可以放在 src/ 下（ext-test）也可以放在 src/suppliers/ 下
    out.push(...findRows(join(dir, entry.name)))
  }
  return out.sort()
}

const missing = []
const rows = findRows(srcRoot)
if (rows.length === 0) {
  console.error('✗ src 下找不到任何行（没有含 row.json 的目录）')
  process.exit(1)
}

for (const sub of rows) {
  const from = join(srcRoot, sub)
  if (!existsSync(join(from, 'index.ts'))) {
    missing.push(`${sub}/index.ts`)
    continue
  }
  const dest = join(root, 'lib', sub)
  mkdirSync(dest, { recursive: true })
  // row.json → package.json（宿主的 readPluginMeta 按 package.json 读名字/说明）
  cpSync(join(from, 'row.json'), join(dest, 'package.json'))
  const locale = join(from, 'locale')
  if (!existsSync(locale)) missing.push(`${sub}/locale`)
  else cpSync(locale, join(dest, 'locale'), { recursive: true })
}

if (missing.length > 0) {
  console.error(`✗ 行缺少自描述资源：${missing.join('、')}`)
  process.exit(1)
}
console.log(`✓ ${rows.length} 个行的资源已拷入 lib（${rows.join('、')}）`)
