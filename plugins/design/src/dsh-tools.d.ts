/**
 * `@deepseek-ai/dsh-tools` 的最小本地类型声明。
 *
 * 打包好的插件只带 `lib/**\/*.js`，package.json 的 `types` 指向的 `lib/types/index.d.ts` 不在发行包里，
 * 所以 TypeScript 解析不到它。这里按实际用到的形状声明，够本插件通过类型检查：
 *   - `defineTool(options)` 返回一个 ToolDefinition，原样交给 `ctx.tools.register`
 *   - `parameters` / `output.schema` 用同一套 JSON-Schema 风格的 DSL
 * 运行期仍然由 DSH 的真实实现负责校验（本文件只影响类型检查，不产生任何运行期代码）。
 *
 * 形状取自 DSH 0.2.0-rc.2：README（`use-this-package`）与内置的 dsh-tool-present 实现。
 */
declare module '@deepseek-ai/dsh-tools' {
  /**
   * 参数/输出的 schema DSL（`type` 为 JSON Schema 的名字，另加 `required`）。
   * `type` 只能是单个名字；可空类型用 `oneOf`（恰好匹配一个分支），不能用 `type: ['string','null']`。
   */
  export interface ValueSchemaSpec {
    type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json';
    required?: boolean;
    description?: string;
    additionalProperties?: boolean;
    properties?: Record<string, ValueSchemaSpec>;
    items?: ValueSchemaSpec;
    enum?: readonly unknown[];
    oneOf?: readonly ValueSchemaSpec[];
    [key: string]: unknown;
  }

  /** 文字块。 */
  export interface ToolTextBlock {
    type: 'text';
    text: string;
  }

  /** 图片块：`attachment` 是 `ctx.attachments.saveImage()` 交回来的引用。 */
  export interface ToolImageBlock {
    type: 'image';
    attachment: {
      attachmentId: string;
      mediaType: string;
      bytes: number;
      width: number;
      height: number;
      name?: string;
    };
  }

  /** 工具返回给模型的内容块。 */
  export type ToolContentBlock = ToolTextBlock | ToolImageBlock;

  /** 一次工具调用的执行上下文。 */
  export interface ToolExecution {
    /** 发起调用的 agent；没有 agent 时（例如非会话调用）为 undefined。 */
    readonly agent?: {
      readonly session: { readonly header: { readonly cwd?: string } };
    };
    /** 协作式取消信号。 */
    readonly signal: AbortSignal;
    readonly callId?: string;
  }

  /** `defineTool` 的选项。 */
  export interface ToolDefinitionOptions<Args = Record<string, unknown>, Value = unknown> {
    name: string;
    description: string;
    parameters: Record<string, ValueSchemaSpec>;
    output: {
      schema: ValueSchemaSpec;
      render: (args: Args, value: Value) => readonly ToolContentBlock[];
    };
    execute: (args: Args, exec: ToolExecution) => Promise<Value> | Value;
    timeoutMs?: number;
    isConcurrencySafe?: boolean;
  }

  /** 构建一个类型化工具定义。 */
  export function defineTool<Args = Record<string, unknown>, Value = unknown>(
    options: ToolDefinitionOptions<Args, Value>,
  ): unknown;
}
