// review-appの他のAPI（app/api/generate-review/route.ts）と同様、OpenAI SDKは
// 使わずサーバーからraw fetchで呼び出す（依存を増やさない、taskに対して十分すぎる
// 抽象化を避けるため）。このファイルはサーバー専用コード（Route Handlerからのみ呼び出す）。
// (blog-appの lib/openai.ts を無変更で移植)

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

interface CallOpenAIJsonOptions {
  systemPrompt: string;
  userPrompt: string;
  schema: JsonSchemaSpec;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export class OpenAICallError extends Error {
  constructor(
    message: string,
    public readonly kind: "timeout" | "api_error" | "invalid_response" | "config"
  ) {
    super(message);
    this.name = "OpenAICallError";
  }
}

export async function callOpenAIJson<T>(options: CallOpenAIJsonOptions): Promise<T> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey || !model) {
    throw new OpenAICallError("OPENAI_API_KEY / OPENAI_MODEL が設定されていません。", "config");
  }

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        messages: [
          { role: "system", content: options.systemPrompt },
          { role: "user", content: options.userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: options.schema.name,
            strict: true,
            schema: options.schema.schema,
          },
        },
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    throw new OpenAICallError(
      isTimeout ? "OpenAI呼び出しがタイムアウトしました。" : "OpenAI呼び出しに失敗しました。",
      isTimeout ? "timeout" : "api_error"
    );
  }

  if (!res.ok) {
    console.error("OpenAI API error", res.status, await res.text());
    throw new OpenAICallError(`OpenAI APIがエラーを返しました (status ${res.status})`, "api_error");
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    console.error("OpenAI response missing content", data);
    throw new OpenAICallError("OpenAIの応答形式が不正です。", "invalid_response");
  }

  try {
    return JSON.parse(content) as T;
  } catch (err) {
    console.error("Failed to parse OpenAI JSON content", content, err);
    throw new OpenAICallError("OpenAIの応答をJSONとして解析できませんでした。", "invalid_response");
  }
}
