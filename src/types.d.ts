/**
 * 最小类型声明：@deepseek-ai/dsh-settings 与 @deepseek-ai/schemastery。
 *
 * tsdown `neverBundle: [/^@deepseek-ai\//]` 会把 @deepseek-ai/* 保留为运行时
 * import（DSH host 全局解析，见 dsh-model/dsh-better-sidebar）。这里只为 tsc
 * 提供够用的形状，不安装依赖。
 */
declare module '@deepseek-ai/dsh-settings' {
  export function settingsNamespace(value: string): string
  export interface SettingsHooks {
    validate?: (value: unknown) => void
    setSource: (source: () => unknown) => void
    onChange: () => void
  }
  export function installSettingsSection(
    ctx: unknown,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: SettingsHooks,
  ): void
}

declare module '@deepseek-ai/schemastery' {
  interface Schema<T> {
    default(value: T): Schema<T>
    optional(): Schema<T | undefined>
    required(): Schema<T>
    step(n: number): Schema<T>
    min(n: number): Schema<T>
    max(n: number): Schema<T>
    role(name: string): Schema<T>
  }
  interface Z {
    string(): Schema<string>
    number(): Schema<number>
    boolean(): Schema<boolean>
    object<T>(shape: { [K in keyof T]: Schema<T[K]> }): Schema<T>
    array<T>(item?: Schema<T>): Schema<T[]>
    union<T>(items: readonly Schema<T>[]): Schema<T>
    const<T>(value: T): Schema<T>
  }
  const z: Z
  export default z
}
