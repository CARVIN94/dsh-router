/**
 * 分层提示词扩展的图标 —— **一张深色圆角瓦片**，以本地 base64 内联（离线可用）。
 *
 * 为什么这样画：它做的事是「一份可以逐条开关的规则清单」⇒ 图形 = 清单 + 勾选。
 * 不用齿轮（那是设置）、不用扳手（那是工具）—— 那两样也在同一个面板里，
 * 混用会让人分不清「改行为」和「改这套规则本身」。
 *
 * ⚠️ **单色 + 深底**（与 RTK logo 同款处理）：`.dshr-providerIcon` 只给圆角与
 * 尺寸、**不给底色**，所以底色必须由本图自带 ⇒ 深浅两套主题下都成立。
 * 勾选用略暖的绿（`#A7C0A5`）与清单的灰白拉开，暗示"这些可以勾掉"。
 *
 * ⚠️ **base64 必须由 `logo.svg` 生成**（`base64 -i logo.svg | tr -d '\n'`）。
 *   我第一版**手编**了一串 base64，解出来是乱码（`tept-Gradient`、`#17118=D`）——
 *   而客户端的 `onError` 会把加载失败的图**静默藏掉**、退回默认闪电图标，
 *   **看起来"正常"、实际图标根本没换**。编造的常量不会报错，这是它最险的地方。
 */
export const PROMPT_LOGO_URL =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+CiAgPHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTYiIGZpbGw9IiMxNzE4MUQiLz4KICA8ZyBmaWxsPSJub25lIiBzdHJva2U9IiNFREVERUIiIHN0cm9rZS13aWR0aD0iMyIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj4KICAgIDxwYXRoIGQ9Ik0xOCAxNmgyMCIvPgogICAgPHBhdGggZD0iTTE4IDI3aDI0Ii8+CiAgICA8cGF0aCBkPSJNMTggMzhoMjQiLz4KICAgIDxwYXRoIGQ9Ik0xOCA0OWgyNCIvPgogIDwvZz4KICA8ZyBmaWxsPSJub25lIiBzdHJva2U9IiNBN0MwQTUiIHN0cm9rZS13aWR0aD0iMy40IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPgogICAgPHBhdGggZD0iTTkgMTYuNWwyLjUgMi41TDE2IDE0LjUiLz4KICAgIDxwYXRoIGQ9Ik05IDI3LjVsMi41IDIuNUwxNiAyNS41Ii8+CiAgICA8cGF0aCBkPSJNOSAzOC41bDIuNSAyLjVMMTYgMzYuNSIvPgogIDwvZz4KPC9zdmc+Cg=='
