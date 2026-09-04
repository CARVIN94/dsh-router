/**
 * nvidia 供应商插件 —— 参考 9Router(open-sse) 的 nvidia 实现。
 *
 * 上游：https://integrate.api.nvidia.com/v1（OpenAI 兼容）
 *   - chat:  POST /v1/chat/completions（SSE 流式 / 非流式）
 *   - models: GET  /v1/models（公开，无需鉴权，返回全量模型）
 *
 * API key 账号：走「添加链接 + 连接池」（同 openrouter），弹窗填名字+key，
 * 一个供应商可有多个命名 key，按池顺序/策略尝试。凭证存通用 CredentialStore
 * （SQLite：auths/credentials.sqlite，{ name, apiKey }）。key 有效性用 chat 探测
 * （无 key → 400，无效 key → 401，有效 → 200）。
 *
 * 模型不内置、不缓存：listModels 每次从上游 /v1/models 拉取（全量，不过滤），
 * 缓存由 dsh-router 核心统一管。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatRequest, ModelInfo } from '../../router/types.ts'
import type { AccountState, ChatOnceResult, SupplierStatusNow } from '../contract.ts'
import type { SupplierEnv, SupplierModule } from '../contract.ts'

export const id = 'nvidia'
export const name = 'NVIDIA NIM'
export const priority = 20 // 同 9Router：免费直连(opencode=0)之后
/**
 * 面板图标（NVIDIA 官方 logo，128×128 PNG，base64 内联）。
 *
 * **必须内联，不能放网络 URL**：之前是 `http://localhost:20128/...`（9router
 * 的端口），9router 没跑时就是一张坏图 —— 面板图标不该依赖另一个服务活着，
 * 更不该依赖特定端口。跟 opencode / openrouter / traework 的做法保持一致。
 */
export const icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAgKADAAQAAAABAAAAgAAAAABIjgR3AAAn10lEQVR4Ae19CXgcxbXu9PTsmzTaN8taLC+ysGTjJWAbAoSADeGCQ2yWYMgFQ+CS8CBcHkveDYF8ELgfLxcc8gIhLAGMIazGBi8YDAZsYxtvsixZsjZrHW2zb9098/6ello1PT0zwpJlm6gRcnX1qapT51Sdc+rUqRIVDocVxMNxnMvlEjPw1WQyqdVqMYdlWbfbLb4iAQCVSiXmjAMAwzDAgaIosVGz2UzTtPg6eoBgMOjxeBI0EQtgsViUSqWIQ1KAQCDg9XqHC4glJxLjSYEJBowntWXammCADFHGM2uCAeNJbZm2VNC6ZHYoFCK1GT5BD0OviuooFgA5IwdAbbI1iGiMBAAwpNoHkqhT7AW+nioAtCugEUFBBkkSAJDoBTUwMCCijgSoD4uCzIExAIUuMgBlYPaQADBIYHWMEAAYwKaKrQEsFOocCYBGozEajSQOsNxIFo4eQKvVGgyGBE3EAjidTnEcoBdJAXQ6nV6vnxBBJJFPQXqCAaeA6GSTEwwgqXEK0ipRLSRoPCnMyAHiQYr5YkKCj5gvJr4fABQULNkTdA8aVczBK3QmucKWAAASAKIGxus4AEDXkWo/FoczAgBWA0wPFennQU+QC7MHCeEBNaHNSRiUkfAMAKRROA4AoD5pmAFVWBSk9Tx6ANSfuIlYAN6kifYFSWqQAGCUAGDYiTZEcwU5nMVMMnGaACRGA1/PCIAJJUwOrVOQnmDAKSA62aRKXIIKuRD6pEDHKx4SBpKLBEAp5IwzAFACDqSEAQ7IFDt2SgCgPoFGAhwkAIDkezHhihBIJnFmxDoSkgJMuCLEwXcmJSZ0wCnmlowZegoxohQUrdSolMNb0AIyKqVWoRzc8uXlu1IjQRIAVHjQrz5GANpkTcgAhBSDOiCCw4gARsQAVEdqPAlmeB05ACBjiw/lUMGQ2+Y/SKto2ju8w46vUG7QYAphEz4cVgZo2iMB4DUcD8BXH6YDtDIeAP99JAAqpTtKPERQiDQxWIMUgAvx/4lI0gEZAHQ/HAoLeNJBpVGdTpGOB6GrWJ4hIT6CK0JkAGghAYDzHV9HCMBjEA7H1hBZQ1I2d80zu+dwYTZCRxEFrA2H00JKwsczEQCMKDBXwRCKmgQYSCRLQKxYVwQJAHLADUBWApP0hAF4UROZIbEElXDgewAQGVThKOoLnRTHsqTP4uvJAwhLRr7Y5Pc2QUWJuVPeTZ61Scf2KcdyTBFIwgCIoDFtbgSVjX+LI0Dq5IGcRq4IDH6WY/kZMO5MP3n0TVqzShLoeQqjIpSUCuGSMfZO0i6c2QBJRNCZ3bkzAfsJBpxiLsmYoacYI2ExG43E91gunRYMUCsNShVHUzStVIXCHFw9oDhN8WmwIxQOBaGcBcZE9DN2XpVQ2dFMOkPfkrgiYIbC00Dud8u6IsjN6GQAsHJojg3B1GEpr58dcDDN3c56Z6C9z38Uy/BzCn+pVVmw605TmlCYxdKMZQOswgs3kYvp6PM1uPw9XZ6Ddv9xP+viXS+o7sxcPMDezh+JK2IMPQ0YpGwo0OHY32zf0WL/qs/f0OetD3CuIDaSwrwjMdtU+PP0teGQwu3ygvSDY1xNmc0GBaGt/EF3j7Ol31/f5t7d4vyi23PYExwAM+jIzDizpoKMCBpDTwMFJzLvXlZ5g/1NA1/W9X3c0P9pv685wPH+PpAUkgSiRB0hLpxTNKUOhZlQSMmFoxyCbIivRKSsitJbVIVWS2lZ6mVhinEG2vqZuiM96+v7N/d6m8FIlfKMEVDDvRK7NyYJJaWGKPdxfc2urUea1zXaP+v3tUDwCINUoPgJN4TZwkunECe43410bq516szsn3iDA/V9W/Z1rWno3+oOusEGnsGn9yPDANL9QKbFjshmil8xVNW01uY7XDew/qBtTbe3PjK0eVpoonz4YokTSZA4wH0NTzwUlUFjrcxdjp9OR83ezlf3d7/W522DxoaSOG2fsVHCkFoUpcQ+ChdmGno/29n2fP3AppGMQRg10EX4gdyAEM825T90XhtefL6AQDJUixUydhwgsKApYBdFTnjwexKkqISlQBoCirAyHFJ6uPa9nf/Y0/Fyt+co2H+6zQZBCY9JVIRHwdGc0ltv/3hXx1+b7F9yYYUqvmUCooPWaB4GjE6lM2vysDGUYZxiUhVoaIM90MSEvIKRCdaoaYNBlWFUZ6TpilPUJWmGYpXCpFXr1LqoUS0JWSAPaMBY2t320rbmJ/v97QmwGv8pIjBARgR9V1QoOnS4792dHc+2OndB2sSTvGgPjAH1jWpzXkrV5NQFk1MWZxhLrbpCjqGxjUgrND2+2v/ZWw7bc5i6kSJgFfS0mlaBDen6qcWp583IWpptno7JkRRbncq8uOjXMzOWfX38z1+3r/ax3lFqoKQtfieAUc0A0PSwbd22pj82OXaAtFCwsY8w3pFv1liLrYvLrEsnWxblW8tJAQKHIPbRQM0+f/3zBxewYWaYAUSNgrwCj9GuXq3PM1fOzLyqIvvfMo3TfB4mwAzGFEM9kDNAqMDj9oHH3b6929oer7Z9eDpIpNHOgBb7jk31Dx/t3yyMemLQDtIM9GI5DFtlqfWcWZnXlFkvsWgKwyFIdfwvS2GC2HJJlOGnQqQoE/I1Duw81r9za9OjU9MumZt382TT+WFOyYb8ckWhPFiOC2TpqpZPfaM8/c3NTb/t93dq5EaMbPGTl5l8Cke3TUFMOwMdnzY+sbPtuSCHnX8Z5caTPqTQqwxn5yybP2lVrm5uiKHZUDAQ9EGFYnhG13kib+ACmsYTYN37ut+p7nlvavqPFxbcNdl0HgsRFufh2ROiZqXdUJJ63qbmB/Z3vi1yNE6Jk54ttYIwf+GUF5vFKzblBQMDjhqGC+zteGVr86N9vjb0X3YYMyGYm6qq7OvOzb8zW1+FGmg1b8qIdcbzVUDxdrvrntldBVNqGFosliwRWWRQZ2VdfcHk+wssc7w+rKUHo3RQFL0gph2+0Awb/Nb24qbG/+MO9gu8TNbCGH8fFEFkQANaQFSEJNJWdEW0O/duOPpAbe8WEFNWjwnSeVraRedNuq/I/EMuxPqDvFw2aaW3eZBNgENiEypajcMv8MBJGIBXgoPyhIgQMbyv85/1/VsW5K06N+8eLWUNst6ItKNwOIL0aCFuwx/wz8m4NdcwZ13Dr1scu9Vjt0aRxy9ObhIRhFFDK9VcKPhZ45OftTzpDbriIQqyZRgmX1r2aGXWNX4vh57HaTEqG9UjDk5FD6LBcL40Q6lKqVdREFMQMRglISbk9rNOV7BbMF4TL6yAno+xf9L033V9my4tebzYfHEEE1mhFIb4glZYWbFuY9O9ezpfhxEhYXwUrifnhcIAJGvGDIBNPZRDaVQGO1fzYf1vanu3Yj0pOwyFgT8v78YlUx9L0eVxLOdyizXwNUnuswGA1+OHj4gL+91Md3+wrsdXY/PUdrmrVbRmZdU7aoUl6Mc5NSVwo5RhjvIr6IAr2NnhOtDm2NswsLXP28Bw4cSut4hvTnNh0f2L8+8LsQqDSXqGSbzwBtYXZOwu29MfNzwElsv2cYggY/mvIIJkGIAwa7QDiQ9H2sHe1z9u/N/uoF1W5gAMkteszfi3aU/PybtOwA7ihWAhn4ej96SgYxm2ZWBPo/2TRsdnne6DnmAv1AaGHgZCtqnogcXHOI5yOR18SSFXQVksKUOhoQrMklb7N992rKnt29Dva0/ABlQINpRnXHrFlL9kpRSTwxsiCEiKWgGWWWpKyv7Ote8cuc3LOsfHdTHIAEkUGzQkE2QwPL1s34bGu/Z3v5VA/oJwhZbZV8/4e4FlNh9PGHlkdSyGNig44Gs90vPRvo7Xj7u+CbDwJUS58jGTMgwldy84BBUTDA4bAqg12tOAYCbsKISdTOuBnjU7jz/X42tJsMSFbMw3n7Wi4oVJKfMZlr9SAROL7yZxGDTShFZNq+t6t7x15Ea7v3Mc1PIgA8gDGsAMQxUDttW+863Dq9pd1fEGPgYXOjY/7/qryldTjNkXGB5NqEFyFUTQH+pw7f+2++WDPWsd/h6e7nLSFgxI1xWvqtih15mNxqh7GoSVmshgmDTiXRHugO3L1tWfN//fAOeNRzVMU4PaevX056ZargywHtCfrEGoFhMCc1erNnX6dq2tub7P1xqvNgF+9L8FBkQtRZQUraZ1u9tfen7vko6E1AexLi19aMVZL+nV1nhrHwHFPm/j+mO//vvBC7e3rXYHe6Ak0bEEuk4UC/F6KAEwabOg+W+u/HgyBji/ryPzoEUfO/DWkZsO9r+iUxsgcGSA+FUeFWQ9Obp515e/m2EoAtvG4RlGBR58pSq8sfk/36z+dz9rj8d/9BCqccmURy6d+gcYSAlQ9DEDm+p/t3rnOdtbn/WzDkymWP0miGkQjv/h+P0ytVKHzcgE1cp+KjCde+PMDQsLfgncMDhiH4j1IOd9p+6Xe3uf06j0sQBiDnRMpq7ihpnvZuiLx4EHg74ghCV7ue51x24/3LsxwQhF19C9ZdOfWTj5VyLGkA+Qp+LAVKs0RpOhoe/TD2rvPu48iNpi6Y6ycMzBvaxTa3IMs9INpSnaSfxqLUxl6isyjWV5KTMhDcgmxKUD5GSsqwcCBNsz0DT7e1/8sOEeTErZRjHrcQTkyrLVP8i/nY7mMmqABSi0iCaM+tQ+pvqFvZcN+I/HG4sieieWEEQQb4CraX1v4NDaIz/v8tTFE/oAE6h/ScnDJPUlbWMXjA371tc9vL3lGSYUkN2B4X2iCI23VM7Lu2lqxo8zDdOYAL8ARBhEj6/u6b3lmFip2sJJKQtmZl1ZnrlUo4q6GkjSovgKZysG75zMVXp16rt1d2ASx/IA6gc7Cusb7jXrM2flXC2WjU2wIV+u+awbq976+74rIDlPnl1Ehbgwdmtfr752IOJdiEVFzAlyih+X3L+k7HGPN+raSsFEgSOBVtJdriPv1q462v8VZH2soAcLIWcKLDMXTbprRtoyrTIVPjL8aDT8dRS8K8IFV0Qlq+APaMCCBL3yzZUXFT9Qmb2C34zBbn3kgQ3DBzHi89BDehqwrKvr2fzygWVMyBPLA5TAJNbSlpWz3i42XxTgPGgXmWQNeMWAwJ4PhmZt/7q3alcyABtubajV0f0rzAB6xZ3zXjv4M1fQlniigfpz81ZcOePPII3P7wMJxAeow/IBBet6P375wJUd7loM/Fhs0W1ovx8W3b28/MVc7QJEprBcAO4K1CPW4An27Wz/fxBOIJxg4DsC3Ydsb8NonJJ+IXwJaAUPivj9fsGaFNAQnBnCV7SdYSjN0JXV9m3E5n4sJiAlnFpN9s9LUy/SKqw4e4RKyBqEJsBjLsTkGCqxUj/av1WWl6NjgcKizVG6/F1YZyWeYhAaU9LOXVb+l0jgVKxxwPdxT/vLLx+42hWwyQoxDGfsal1X8doV05/Sq9N4W5DwlCXoBq+QKMWmxsfeq/kVIrQSQEo+aWkzZJokU3yFPwPCHZFI6JGYGZvA2p9RuDvdB2I/jVWOsjLnmmxjGUic4AH5SlIXG9RpsjAg//am1f88fBvDeTFsYx/YEmn6wpvPXj8771p8jcS7xULFzUH9mFJfHv/LZ42PxwWK/oB94Ferr4bpGTv8BUBIwvMLfzMt9QrYXdFFh99AffipsBrd07VWtl/DoKNIKbVq47z8m4gj9jKVoflq23uBIf8a5j7xQCaFDve+GwwFZScpJA8Y/IvZ7xemLBCrJorzSTE/QUJFKzYde7iud5MAE6+GcJjbePS/1lbfEuTkFQCKw+Styr7i/IKHgmxArEfSNBQDbKrPO/6wu+Nl2TktgT/hVyU8M7OyVpi1qQnoAAFl8zYc7d0Erxa0E7Qu8QA9VUXGT+NhgNkzK/vqPONsmKrCA4FLFOeTyMEnGJqILolXD8YyG2Y/rLvH4e2Gx0xSA7BCHCnigtYcvH5T46MUxcmOBlSOsT85Zc6yac+rlXq1mhbrQQ1DCPK4IERsZ/dTW1seg7A6qQ9/QMOomVSRedWOtpfiuZqBARcOfdP+Qonx0pCCldxr6fUEiiwXmDRmPwOHhBRbrDob+j5x5z0I+grDDX2W+CqElQT6PBhsEmdKwOHT7qrZ2PDgsml/k9Tg97Cd7iP/rLux2Z7Is4/RkGEo/OnUF3V0hkaHHYDhs9SCKyKCPaVVG3b1rN7c9AiIH9MhaQdH+c67BUCaH+T9h0FtSDAJoAwb+j/p9h/gT5JGPwgmtGqmTE+7XHYrEFQ77trX5t6hUupgOJK2I1kNnz+CvgKNb7vWNDk+I8si3enb/erhK5sT7qtAz5m1mdeUv56mnsZwMlvHEexAfeO+3hfW1d+Dy9tix5Ok3dG/8hMMtlqmbtas7OUQjvEeEMfPBb/t/rtKJeN+gAyZk/MLTRzPBBNi99leITek4rWSNB9oMCH/5sbfYo9IBN7fsfbFA5fbPEcTCGuoIj1tWTb1b7m6BUHOJ5aNTlBalXFvz18/OPq/sDoZB+qj9UEJhw3Sc3PvtmjTgGi8B6Nvf9faHn91LAAXCkwyLpxivUDWeYKCh2zv2fz74eWOLftdc1Bbo30ngu+EgtuanlhTvdLH9icwVDD2sfJaPuOVspTLoJxlW4TNg4jK7R2PfxgZ+/FUiGzZ0WQOMgBiJEM7Y0HuqgT2KEafm3F/3fZMbHt89FSYWlhwD+/Pi/mMgj7Gu6P9GbXc7IkBT54B6nza9Fiv59j7NXd+WHc/ZEUCekHu61UpK2b8oyzlcuxBxqtdpaI/a3t4U9PvcD9V0rGPcRbbzXg1J86nRCcX9I2X6fvzNwt6fU3x1mVQEhradEvV1mx9pSgEsI7F0jEiQBX/OLDsQNe6WGUOdJUK9ao5m4ut52Hbnwy8AH6oQRBQ3U7eFQGvKHiW+EGFFk2uI9CZWHeA+iZN+vLylxA7jTOwggaCLQCZKeIA5R+mg+sa7tzV9qqs84rEhKd7WFFqPb/FsSPIBRNMO7KUbBrExAENJXo+9CjNuswfl/4+gSpGb72s+4vWP8KdBrtNeEB9uCJQiVJJLyl7zKRJjVUlEdnNwIBBOD9N81e2kw9qEHBAQhbX2ExUCOpj4CdgFVSaVV9wQ8W7xcZLYOAKSKIhJMAJjDw8VFjlYXrerLn+mxFQn5fPYfqS0kdXzd1yY9X78FNhKiQQ2rFox+ZIO1yVe+309B8l0MZQdId63q93bICjKra6bNPMC4vvi6cJjg3s+KzxCTrOfkhsbYlzEogdFEQXCsyVN521IaJ15UM0NLQRIQFv1P7soG197KyVtI7JpFNZrpv1jx9N+S38tdPSlvyiYsuSkscM6nS0xc+ME3qkDMCq6uKix4xqSwLGYgpvafodE3bKbi0tLLyrOGWuPA9oxdamxw/3bEDPTwjbERUCLbDampV1xcqZH1rVUxHEKFtMp7Ycc218pfryZseupJIH3bHqJt9U9d7s3MHYA4YLUiHNwtzf3Fb1+aKCO2hKi0ZP4JEyAI6abF3l+ZP+M4E2huBrdx3+ov0xrQpLBynvNUrDT0pXG9UpsSyMCCL/O0du7Q0exrIAZYXnBPCOVwRoKynN0rJHfjb1NXg6gyyCIflHAg+X9c7uP71Rc6090A6zKvEDT3CJdeHt87fCI0tCglbwKprpyZcUPnXzrC1zcpfD4Ss78shSkjT90EMPQSNFPWFuUurcdvcOm6clnpKBrG5zfVuStjDdUMa71yJqTagEui5VNzlFl3+45wNIaImMhtzwMq4W1/YZmUvM2myESkAoQyLzRAqFcQLym46/wrkkKSVBWvYVNEbns4xTlk9/aX7+LdAxVKRyQbugCQE95LkY27q6u7c2P4GpkliOYQzhZ17+dT+b8bJFkw/zQSQU8EWdET88BEHYqiuqzFleYJ434G/s97cBmcQ1C12AO5rq7+8n+4MaBU9Dt+vIX/dc6Ap2xasIvS2wzLpj3vZQUOMPIAJwkGi4YUvwE3x89MEtjY/Lji8IzUmWyhsq30RkOVoXXBHYlO4PJApPJ/GUpCGgocDn5tx4YeF/GZS5CpoVwyYESJfLiUgWjdrY6t62rv7X8FuMROhDVC4tewzHC1AJ4auACcKHU0r+xAbiqWiFlgl7qvve2t72pM3bhL4nGEmCFUTff//9oJ34oBswCtGeSZsJ/hy0vR/PzgNjBnzdQXZgqnUp9lXIGuDtQQ1T0i7wBLub7HtjpxHMXLu/u7Z3fa6pEodemCD2xbAJo8R6am/3C7AsEuAtEFT8DZmDn1xTxVVTnz0n7x5lSAcPM0a9gIMIBgQhHnZ0/mld/Z32QEdS6kOgpxkKb5i1ZvZQwBn8VMKoR09RLUYqeac5coQNHAz9SeYFiBEOKxgE42CvJ94IRhFQmGeAiCUSIgOQzjXPYjh3Q//XsRQUiiC/xbHXpE0vsixG9LmQiRqEzgPRqRkXuwKtLY4DsTUALQ9jP9C1lg0HJpnnq5UmdA/RYCNkAOY4Rj3kQ66pfMmU3y8peTJDM4uBxI/s88QyoNO97+26X+zqfAmrtlhkBMyF3xiYcGpVZF+2svLNgpS54ieBAeKrLAPQBQBgH41W6GflXFWc/oNu92FnsCveeErCANRVlLqo1b69x9cab2mGqnEoLN8yO0M3HWHlKCIygE9TqumZS71Md4vjW0AOSSl84R/wIKTg6vu+aLB/pFFrs03TgfqO9qdxQDsexugfiA7ph3Mfk1MW/KjkgSunP12ctogJ4ADG8NYKyQCsfj9vfOrtI6ts3nrY0BIcBEzE35hMsA4uLLzvymmrzfosMR+JkTMAwFBolJLKTpmmU6ZBF2KWyvaI1wFkZBxKAnWJt7nH1fC3fRfjALSsNEcRIJ2izVlZ8UGmthKhyKIOwCfhCfiZba1/2Nr8R3j9ZBmJsQzKQqOUpP6wceDzbu9haHJ+NYfcCOIYWPgXDNOqdFZdcWnaD6HxilMXYwEnNCEJKsEUFHRAdfcHm489fNyxnxfHsjQYxJFvCmInx1R2xZSni0wXIfjRYIha6EiagKCO1QFQ0UJ90GcajWpX15+xiQQpItu0oANIVwRfFlVgv3sIK17bWIyWJsfXL+673MsOyJIPwKBWpqH0trM/TdUX4g88iKt8oR78uSa1SlXb+9E7NXf0eFsgf2VJAc2cYSi45weH+n1Nna7DNleti+niwrDiKS2dajXkZhsrM41TrPoiNaXzegPwX/E+qMgDlYiZF0lSWOjBLGsa+OqL1qdqetdBCscbOkJZ/MYYwqxbkH/LkrJHTZpsLJuxSEYvBHEvgBFN8BmxADiCEIFHdIiyx31s47EHv+18KwHjBxkgiC2hDfyG9QZWi6/4CpMGg7rG9uGrB67BAdJ4KgXDpyRtwU2zPzCrsgccAyTqqAESE3U6/O2bGn6HDVsWjoEY6xuyJdNYet+iOhxfwSYPHwzP317GjymDUUsyDVtWMJzIJjBrMXcFtDtdB79o/hMct37Wn1TZCgM/y1C8dOrjVbkrxI5D4JzwX1Pd1/HGRw3393pbE7jH0ZDAgEQxASI2SJRn/WRZ+TP/PHx7vG0KdLWxf9cr+666tnyNTpUju+OBxcHyihfOyl62ueH3rY5v0HnoQ8lsiKwoIA2ilq8ajnfgkPiQaYSw4IEHv6n/SwTqHu3b6GW82ENOSn1MXA2tm1/w8/MnPZiVWkzW+V3TfBiNUgneIxqzuud9dC0x9cX64/ZKhBAT8/JvxoR4u+Z2dFV2HvA8GNjxt/0Xr5jxWrZ2TjzP+4z0pXnac3Cqe0/XS032bbgLCMJDtkKxabkElJwKjkw4lpzM8eqWV/d3vdHi+JrheIGTlPSYbRA7xakLLp78CPZTGTaAqS/OIbnm4uZFNhL0bq5jfe0fdrU/5w46krZO1iXDAFIokWkUm19wC8TuO4fviMcDdN7maXi1+qqfTnu+xHIpzu5iRJPtIY2ILJx6mZ66bJr1J53efXX9GxrsW3BvjSvohgkP9QXJg16J8h1FJE4nBPLTKsrhbzzu3lVv39Rs324P2DCTRkr6kCLdULgo/67ZWTfRCgMuv4lgGKVykSPpewRG8os/MxoMO/f2vPZl21M2T+NIEJBWAWFHZqFVSFgyB3Mf0lYUuAiV2dP54nu1dwU4dzydjMGFmIOLih/E8SBUCFNFrAGveKDB0ATojD0yhEbhPqZeb0Obcw+uACpNPz9FU0hzZpyOAhsES0ilwSlXv58bcAbbBzytOJIPYJu3xs96MZaBxkgmkGC/WnU5C/JXzc/7ZYomL8DwtxIJnYWeE/tIIimSQgRAETSIMHtP0H6k7wPsUB13fovOxKOGWIMkMaiE47kiRGjoItIeEKzM2p6P1hxc6Wb6wHPZB7Vj5FdmXX3ZtCdMiiJvAMee+K6ib7ARJTENbrcHIaoYTbiq4Nl9Z9FKPXwARk06JAxfKhK272XsOFOGUE4c/uYnCL/gwL8jegSBY9VlnZV5zbycW9O10xRKVm/QkYWTehoEAMg9HKHwcr31jvW7O59vse9BJYlXdmQrZHpQCYtsJ79J0uL4FfOxvLpt7idrq1cedx6S9eVCjMAo2df1dpP9qwuLHpqddQPFabGfDkNXrIRIwBHHIn4fIgjSJhDygNDOoE0EAKEFWqPakUtYMBx2OX7jtMXZuTdWZd5gpidhxY7wGYmjQmgoMSlwakGl1tmZpgMda/bb1vR46lHqxEgv9gsJGR1Afk6Qzk+punXu5ndrfrW/++14R7RALJxufK/uzgPdbywuuLck5SIqBEdTYsc5iJxk0ZQAK+ETZCAWd1qVerJ17vz8myuyltFcSiDoAY+Tlo0H0OHZvd+2tqbvbXjAMPlGT3qhoRNnAMqbtTk3VL2R0zBjW/NT6JssTpDO+Gm0f9Xs+Kok9fyF+XdNy7g0XidHk8+P9wjdIRVzjDNnZF5WmXN1vmUOzl2hWgiQ7xSTKnpDcNlabc/HezpfaRzY5meZE1CziTs1KgagasjECwt/j4syNjTee9y5P56zRVAVDQOfN9o/L7TMPzvvxhmZS9MMRQJyEZGeGE/5r6A4r2x4NYHAE022qWJK2o+KUhZNTllkNljlyyTJxUIaofbqkCLYbP/6UOc7h3rehRsGhTC8ZIVtkvqSfU7uisASnDSQJb4K1K/V6jRqNY77bm/5n20tTwU4f+I1iODFNGvTJlnmlWdeVmjGrk6pQZMCxdrjbHzi61JoCUwaUsFidPM/EZMFvwUZpVZSBk1mmq4k0zCjKPWcYusi1IOIWoDCkMMhBlKmSxwJsPrhcSEBjAYzLBv8HZQed11t78cHbGvbXXuxqgDdR2JiJaOzzHdBCcsc1JZ1RYgVwIKEG0B8RUL0NCDd1L99S+Mjdb2fgF7xDCShLJqHpMaDmz3S9WXZpvI802yjJhObBI5ABzYSEL8m8kCvsaooHeLjdapUWEepukKrpsSinpRmLNYq0hAeoDdGxesl9lWgUR7A5capNBha/F0MYb9X0X7M/smh7vePO3d5GP7Px8hKVAH5Mfl9UhgAzFiOgTMEd1O1jsxEAxcgQwTxnWOa9MDiZux3O1198IiJRrrFZNWoNdj4HhyzIYXHDWcch5+IuRsmfUGD9I3vLAIAH0rtDTBhd7f3YIN9M5bQHa69HoY/hwS6i4wfE0LHq0RgwGh1gEztYeXM1GvKLJchdGVHx7Mtjm9A3HhmEoqjt1jCDP4oNSAo7i7DXa1qAjUtbYKrRWyL4RjofFKAiJ/iJQRVLHyFT7DFvrOme327e3e35wjuKeVxGIEDI17lo8knejlUDdZKQ0n55TgJIEISCdxCgpNvdHnqimnWyxudnx6w4SLPLbhEkbeIko0vjEHY7rzFMowFkrxeIJqQR4wEAGdBdP7wsxJ3OQacwQ5sToHuxwa2druPOAM2QdOA8Yk1VnSdY/+minVFCHvCQlOgNbQuCYMcEgBgUGjiRgReCQBWpdDPTF9Wkbmsy1N9pPfDmt4POt37YczxnIj8SDqEslh1I65kJE2QM4A/2xGChwDheXw2PKG4BhwbnF3ugx3ePS32L23eI65gD9yfQrsY74POawkG4/4aNypCxETWFSF+RQI6GRwSySH4KiQAuP1crdKyYa/NV33ctaPF8SXuSRnwQ9zz4xxEAdWQStcV3VqxU/auiGEPFUKdtTqDMcp35vP6PX67N9zZ5zvW56/rdB7qC9Tirl4fa4frApXL8ptEcvzTgzpAJFwCDACTGCwpAHavgrwDjsrSVBXmnXtB6b24VqnHU4ddAQiE486dXqY/ch5arcGdoKooLw0Q09B6eAIwP/hjrYogS3n6fV3eoN3ub8F96r3uxgH/MZunzsv2+lgPVA4enuKRFfXIXRcJKHDyPsnogJPXGG994K/owe+mMOE8e2HqAvygOa/Xi4slfFx/n/fYW/XX4AIQkzpDQ5uxykMRkNHPOIMhF4JWfEGHm4EkwTWVNh/r5M2niLdHGOC88In8nMwujHHd48wAeeyhQlRhc6oqg9Mo6no3YquXEi3QSAneLhxamoHKeOV/BHKfJrJcvmfJc08LBgBNfijj4vowy/8p1RO6NTF5X09LiMFARBE3DEbJShiLeDzxAJCPrwgIGD0AFIlHoYsIcLGy73+CP1gh6SXMSjEHeg90IWF4TUgAAHIMARCdyHt8/pWeqNXNKe84eMmL9n+l5/RiAKbXv9oMkFHCPBWGHjI9lJfcDSBbSiyORFIAEvj7nT6prohB0sX3VUQBQPrAn8AbmMMD4PtNfPQOZwQ9UQeXEYQiCc4dE1eE6KvA2JeLiuBvnYNr3ueP2mn4fpM/MswoPuYnaT8BkxhsTACwQ5Oizb9p1gbUBscRiRUi10iphSBAfueLeE4CAI2bxIkWFDFNSAGCrJ+Yu2H+8G50DdEA8NbiEqt0GR1AtjqeaehfNWXM1y2COw+7X2TTfi9/mY2QI8whrT4Kcx8CHoaM4zEBgDs2cp3KMBaSJmIBvNgjGgpPBw5JAbB+UmsTXtg13Ph4pcADPjSI70YUA5CJgEaRAQg/10YH1ABAvGsInR89AI24XUXU7b2SJmQBSAYkBWBDiDvTn15m6Hgx+jRqhxJnroAUeAjfpIggRhPcDGRoOOB9vqjYccnfRhgHAIgj4ECqJRxWGTqgweM+egAYBZKwCUkTYwXAXzcpkhsJUFycR8Ir+knC4CsJAJjxB0CLwIFkgASHUwIAKpGEisVBAgDSoRdR1EfWxDPOFJhgwDgTXNpclDEnfIQUEqHIdOJM8SsSsqW+9wCkSBQ6K6GDLAAlOdGIMhK1LPiixcKjBBBwim2CrB/Yn3IA4ClRdaADieRYAZxGrghx1MTzVYgAWOPEXAXB//2LMQTAKklyDFg4oCE2EQvgcDhEnoE9SQFgPaKJ08gVIfQt3m9x9J22AMAwMZKyABNKOB5Dxyl/ggHjROh4zUwwIB5lxil/whUxSOiT5GkgtYJsExOuiEEGgFKJHQlJASSeBsBL/CUSADQ84YoYJzmToJkJHZCAOOPxacIVEZfKwqI97ucYjwsp7oVSkhpkASjyeiahmLicwyuqIMPiYgGQQ4rOcQOAr4LsTywOowRAx2MluNA74fdYAajI7RdUfQqjIsSO/Uu5Iv4/JHEpbXhZ80IAAAAASUVORK5CYII='

const BASE = 'https://integrate.api.nvidia.com/v1'
const MODELS_URL = `${BASE}/models`
const CHAT_URL = `${BASE}/chat/completions`
/** 默认前缀（用户可在面板改；loader 包装会优先用 store 里的值）。 */
/** 非聊天用途的模型（护栏/翻译/解析/检测/图像生成等），聊天路由用不上，拉列表时过滤掉。 */
const NON_CHAT_MODEL = /(guard|safety|moderation|translate|transcription|parse|detector|embed|rerank|diffusion|tts|asr|calibration)/i


/** 剥 alias 前缀（nv/xxx → xxx）。 */
/** 剥本供应商 alias 前缀（只剥自己的，模型 id 自带的斜杠保留）。 */
function stripAlias(model: string, alias: string): string {
  return alias !== '' && model.startsWith(`${alias}/`) ? model.slice(alias.length + 1) : model
}

interface ApiKeyAccount {
  name: string
  apiKey: string
}

export default function factory(env: SupplierEnv): SupplierModule {
  // 模型缓存由 dsh-router 核心统一管；插件每次拉取，失败回退上次成功结果
  let modelsCache: ModelInfo[] | undefined
  /** 上次 chatOnce 失败原因（供核心测试模型汇总诊断）。 */
  function listKeys(): string[] {
    return env.credentials.list(id)
  }

  function getKey(uid: string): ApiKeyAccount | undefined {
    return env.credentials.get<ApiKeyAccount>(id, uid)
  }

  /** 账号顺序：池顺序优先，未配置按凭证原始顺序。 */
  function orderedKeys(): Array<{ uid: string; acct: ApiKeyAccount }> {
    const byUid = new Map(listKeys().map((uid) => [uid, uid] as const))
    const order = env.store.get(id).poolOrder
    const uids = [...order.filter((u) => byUid.has(u)), ...listKeys().filter((u) => !order.includes(u))]
    return uids.map((uid) => ({ uid, acct: getKey(uid)! })).filter((x) => x.acct !== undefined)
  }

  /** 当前前缀（与 loader 包装一致：store 覆盖默认值）。 */
  function currentAlias(): string {
    return env.store.get(id).alias || id
  }

  // ---- 模型可用性探测（NIM 的 /v1/models 无状态字段，大量模型已下线/未授权） ----
  // 判定：200=可用；404/410=死（下线或未授权给该账号）；401/403=key 无效；其余=未知（下次再试）。
  // 结果持久化到 dataDir，force 刷新只探测「未探测过」的模型，避免每次全量探测。

  /** 已确认不可用的模型（下线/未授权）。 */
  const deadModels = new Set<string>()
  /** 已确认可用的模型（避免重复探测）。 */
  const okModels = new Set<string>()
  const PROBE_CONCURRENCY = 8

  function probeFile(): string {
    return join(env.dataDir, 'nvidia-models.json')
  }

  function loadProbeState(): void {
    try {
      const j = JSON.parse(readFileSync(probeFile(), 'utf8')) as { dead?: string[]; ok?: string[] }
      for (const m of j.dead ?? []) deadModels.add(m)
      for (const m of j.ok ?? []) okModels.add(m)
    } catch {
      // 首次无文件
    }
  }

  function saveProbeState(): void {
    try {
      mkdirSync(env.dataDir, { recursive: true })
      const tmp = `${probeFile()}.tmp`
      writeFileSync(tmp, JSON.stringify({ dead: [...deadModels], ok: [...okModels], at: Date.now() }))
      renameSync(tmp, probeFile())
    } catch {
      // 持久化失败不影响主流程
    }
  }

  loadProbeState()

  /** 探测单个模型：'ok' | 'dead' | 'unauthorized' | 'unknown'。 */
  async function probeModel(apiKey: string, model: string): Promise<'ok' | 'dead' | 'unauthorized' | 'unknown'> {
    try {
      const r = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'User-Agent': 'dsh-router' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 1 }),
        signal: AbortSignal.timeout(15000),
      })
      if (r.ok) return 'ok'
      if (r.status === 401 || r.status === 403) return 'unauthorized'
      if (r.status === 404 || r.status === 410) return 'dead'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /** 并发探测全部「未探测过」的模型，更新 dead/ok 并持久化。 */
  async function probeAll(ids: string[]): Promise<void> {
    // 探测是尽力而为：随便挑一个 key，冷却/健康由核心在真正请求时才判断
    const acct = orderedKeys()[0]
    if (acct === undefined) return // 无 key：不探测，保持原样
    const todo = ids.filter((m) => !deadModels.has(m) && !okModels.has(m) && !NON_CHAT_MODEL.test(m))
    if (todo.length === 0) return
    let cursor = 0
    let unauthorized = false
    let changed = false
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, todo.length) }, async () => {
        for (;;) {
          const i = cursor++
          if (i >= todo.length || unauthorized) return
          const model = todo[i]!
          const r = await probeModel(acct.acct.apiKey, model)
          if (r === 'unauthorized') unauthorized = true
          else if (r === 'ok') { okModels.add(model); changed = true }
          else if (r === 'dead') { deadModels.add(model); changed = true }
        }
      }),
    )
    if (changed) saveProbeState()
    env.log(`nvidia probe: ${okModels.size} ok / ${deadModels.size} dead`)
  }

  async function refreshModels(force = false): Promise<ModelInfo[]> {
    try {
      const resp = await fetch(MODELS_URL, {
        headers: { 'User-Agent': 'dsh-router' },
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) return []
      const json = (await resp.json()) as { data?: Array<{ id: string; context_length?: number }> }
      const raw = json.data ?? []
      const models: ModelInfo[] = []
      const ids = new Set<string>()
      for (const m of raw) {
        if (m.id === '' || ids.has(m.id)) continue
        ids.add(m.id)
        const entry: ModelInfo = { id: m.id }
        if ((m.context_length ?? 0) > 0) entry.context_length = Math.round((m.context_length ?? 0) / 1000)
        models.push(entry)
      }
      if (models.length > 0) modelsCache = models
      if (force && models.length > 0) await probeAll(models.map((m) => m.id))
      return models.filter((m) => !deadModels.has(m.id) && !NON_CHAT_MODEL.test(m.id))
    } catch {
      return (modelsCache ?? []).filter((m) => !deadModels.has(m.id) && !NON_CHAT_MODEL.test(m.id))
    }
  }

  async function allModels(force: boolean): Promise<ModelInfo[]> {
    return refreshModels(force)
  }

  /** key 有效性探测：只有 401/403 才算 key 无效。
   *  NIM 模型下线很快（410）或没授权给该账号（404），那是模型问题不是 key 问题——
   *  固定探测某个模型迟早腐化，故 404/410 视为 key 有效。 */
  async function probeKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    const probe = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'User-Agent': 'dsh-router' },
      body: JSON.stringify({ model: 'nvidia/nemotron-3-ultra-550b-a55b', messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 1 }),
      signal: AbortSignal.timeout(30000),
    })
    if (probe.ok) return { ok: true }
    if (probe.status === 401 || probe.status === 403) {
      const text = await probe.text().catch(() => '')
      return { ok: false, error: `key 无效: ${probe.status} ${text.slice(0, 200)}` }
    }
    // 404/410 等：模型端问题（下线/未授权），key 本身已通过鉴权
    return { ok: true }
  }

  return {
    id,
    name,
    priority,
    icon,
    status: (): SupplierStatusNow => {
      // 只报「现在状态」：凭证是否存在。冷却/禁用/错误累计由核心叠加。
      const accounts = orderedKeys().map(({ uid, acct }) => ({
        uid,
        nickname: acct.name || 'API Key',
        credits: 0,
        state: 'ok' as AccountState,
      }))
      return { id, name, accounts }
    },
    listModels: (force?: boolean): Promise<ModelInfo[]> => allModels(!!force),
    async addApiKey(input: { name: string; apiKey: string }): Promise<{ ok: boolean; error?: string; account?: { uid: string; nickname: string } }> {
      const key = input.apiKey.trim()
      if (key === '') return { ok: false, error: 'API key 不能为空' }
      try {
        const r = await probeKey(key)
        if (!r.ok) return r
      } catch (err) {
        return { ok: false, error: `验证失败: ${(err as Error).message}` }
      }
      // uid：key-<序号>，避免重复
      let n = listKeys().length + 1
      let uid = `key-${n}`
      while (getKey(uid) !== undefined) uid = `key-${++n}`
      env.credentials.save(id, uid, { name: input.name.trim() || `Key ${n}`, apiKey: key })
      env.log(`nvidia add api key ${uid}`)
      return { ok: true, account: { uid, nickname: input.name.trim() || `Key ${n}` } }
    },
    async removeLink(uid: string): Promise<boolean> {
      if (getKey(uid) === undefined) return false
      env.credentials.remove(id, uid)
      return true
    },
    /** 对单个 key 调一次上游。选号/冷却/换号是核心的活，这里只报结果。 */
    async chatOnce(uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult> {
      const base = stripAlias(req.model, currentAlias())
      if (!(await allModels(false)).some((m) => m.id === base)) {
        const msg = `unknown model ${JSON.stringify(req.model)}`
        return { ok: false, state: 'no_such_model', message: msg }
      }
      const acct = getKey(uid)
      if (acct === undefined) {
        const msg = `unknown account ${JSON.stringify(uid)}`
        return { ok: false, state: 'no_such_model', message: msg }
      }

      let body = req.rawBody
      try {
        const obj = JSON.parse(body) as Record<string, unknown>
        obj.model = base
        if (lv !== 'auto' && lv !== '' && lv !== 'none' && lv !== 'off') obj.reasoning_effort = lv
        else if (lv === 'none' || lv === 'off') {
          delete obj.reasoning_effort
          delete obj.reasoning_summary
        }
        body = JSON.stringify(obj)
      } catch {
        // 保持原样
      }

      let upstream: Response
      try {
        upstream = await fetch(CHAT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${acct.apiKey}`, 'User-Agent': 'dsh-router' },
          body,
          signal: AbortSignal.timeout(120000),
        })
      } catch (err) {
        const msg = (err as Error).message
        return { ok: false, state: 'transport', message: msg }
      }

      if (upstream.status < 200 || upstream.status >= 300) {
        const text = await upstream.text().catch(() => '')
        const msg = `upstream ${upstream.status}: ${text.slice(0, 120)}`
        const state: AccountState =
          upstream.status === 429 ? 'rate_limit'
            : upstream.status === 401 || upstream.status === 403 ? 'session_dead'
              : upstream.status === 404 ? 'unavailable'
                : 'unknown'
        return { ok: false, state, message: msg }
      }

      // 流式：上游已是 OpenAI SSE，原样交回核心写
      if (req.stream) {
        if (!upstream.body) {
          const msg = 'nvidia upstream: empty stream body'
          return { ok: false, state: 'transport', message: msg }
        }
        return { ok: true, stream: upstream.body }
      }
      const text = await upstream.text().catch(() => '')
      if (text === '') {
        const msg = 'nvidia upstream: empty body'
        return { ok: false, state: 'transport', message: msg }
      }
      return { ok: true, status: upstream.status, body: text }
    },
    dispose: (): void => {
      modelsCache = undefined
    },
  }
}

