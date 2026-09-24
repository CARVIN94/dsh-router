/**
 * CSS 花括号平衡检查。
 * 为什么要这个：迁移到设置页时我手滑留下一个未闭合的 `{`，结果它**之后的所有
 * 规则被整段吞掉**（浏览器把后面全当成该块的内容），表现为「样式凭空消失」
 * 且构建不报错——症状离原因极远，必须机器拦。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// 路径按脚本自身位置解析。曾经写死主检出的绝对路径，于是**在 worktree 里构建
// 时检查的是主检出那份文件** —— 在领地（worktree）里改错文件也照样绿，闸门
// 形同虚设：本次加样式时就撞上了（报 3301 行 = 主检出那份的 3300 + 1）。
const p = fileURLToPath(new URL('../src/client/router.css', import.meta.url))
const s = readFileSync(p, 'utf8')
let depth = 0, line = 1, bad = null, stack = []
for (const ch of s) {
  if (ch === '\n') { line += 1; continue }
  if (ch === '{') { depth += 1; stack.push(line) }
  else if (ch === '}') {
    depth -= 1
    if (depth < 0) { bad = `第 ${line} 行多余的 }`; break }
    stack.pop()
  }
}
if (bad === null && depth > 0) bad = `有 ${depth} 个 { 未闭合，起始行：${stack.slice(-3).join(', ')}`
console.log(bad === null ? `✓ CSS 花括号平衡（${s.split('\n').length} 行）` : `✗ ${bad}`)
process.exit(bad === null ? 0 : 1)
