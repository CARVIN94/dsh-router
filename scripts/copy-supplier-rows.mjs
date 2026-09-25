/**
 * 把每个供应商**行**的自描述资源拷到 `lib/suppliers/<x>/`。
 *
 * 为什么需要这一步：宿主的插件页按**模块说明符的子路径**读行的显示信息 ——
 * `dsh-router-core/suppliers/nvidia/locale/zh.json` 与
 * `.../suppliers/nvidia/package.json`（`readPluginMeta` 用完整说明符解析资源，
 * 不是只取包名）。这些文件得跟着 js 一起发布，而 tsdown 只产 js。
 *
 * 两个刻意的形状：
 *   1. 源码里那份叫 **`row.json`** 而不是 `package.json`：子目录里放
 *      `package.json` 会让 rolldown 把那个目录当**包边界**，于是
 *      `src/suppliers/<x>/index.ts` 这个入口解析失败（实测报
 *      `UNRESOLVED_ENTRY`）。所以清单在源码里换个名字，**拷出去时改回**
 *      `package.json` —— 宿主只认后者。
 *   2. 少拷一个的后果是**静默**的：行还在、能开关，只是标题退化成模块说明符
 *      （`dsh-router-core/suppliers/nvidia`）、说明全没有。所以这件事由
 *      check-publish 盯着（缺文件直接变红），不靠人记得。
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const srcRoot = join(root, 'src', 'suppliers')
const outRoot = join(root, 'lib', 'suppliers')

const missing = []
for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const from = join(srcRoot, entry.name)
  if (!existsSync(join(from, 'index.ts'))) continue // 不是行，跳过
  const dest = join(outRoot, entry.name)
  mkdirSync(dest, { recursive: true })
  // row.json → package.json（宿主的 readPluginMeta 按 package.json 读名字/说明）。
  // 复制而不是移动：源文件必须留着，下一次构建的 check-publish 还要查它。
  const rowJson = join(from, 'row.json')
  if (!existsSync(rowJson)) missing.push(`${entry.name}/row.json`)
  else cpSync(rowJson, join(dest, 'package.json'))
  const locale = join(from, 'locale')
  if (!existsSync(locale)) missing.push(`${entry.name}/locale`)
  else cpSync(locale, join(dest, 'locale'), { recursive: true })
}

if (missing.length > 0) {
  console.error(`✗ 供应商行缺少自描述资源：${missing.join('、')}`)
  process.exit(1)
}
console.log('✓ 供应商行资源已拷入 lib/suppliers/*')
