import "server-only";

// 口コミ465の新機能(口コミ生成v2・AI返信など)向けの共通OpenAIクライアント
// (docs/plans/reviews-465-plan.md §6)。lib/blog/openai.ts と同じくSDKは使わず
// raw fetchで Chat Completions を呼ぶが、次の点が異なる:
//  ・タスクごとにモデルを切り替えられる(OPENAI_MODEL_<TASK>。未設定なら OPENAI_MODEL)。
//  ・トークン使用量(usage)と所要時間を返す(生成イベントの記録用)。
//  ・429 / 5xx / 通信エラーは、全体のタイムアウトの範囲内で短く待って再試行する。
//  ・プロンプトと応答の本文はログに出さない(お客様の回答や口コミ本文を含むため)。
//  ・max_tokens ではなく max_completion_tokens を送り、temperature は指定されたときだけ送る
//    (推論系モデルは max_tokens や既定値以外の temperature を受け付けないため)。
// blog機能は挙動を変えないよう、引き続き lib/blog/openai.ts を使う(統合は別途行う)。

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

export type OpenAITask =
  | "review_generation"
  | "review_verification"
  | "review_repair"
  | "reply_generation";

const TASK_MODEL_ENV: Record<OpenAITask, string> = {
  review_generation: "OPENAI_MODEL_REVIEW_GENERATION",
  review_verification: "OPENAI_MODEL_REVIEW_VERIFICATION",
  review_repair: "OPENAI_MODEL_REVIEW_REPAIR",
  reply_generation: "OPENAI_MODEL_REPLY_GENERATION",
};

/** タスク用のモデル名。タスク別の環境変数が無ければ OPENAI_MODEL を使う。 */
export function resolveOpenAIModel(task: OpenAITask): string | null {
  const taskModel = process.env[TASK_MODEL_ENV[task]]?.trim();
  if (taskModel) return taskModel;
  return process.env.OPENAI_MODEL?.trim() || null;
}

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface CallOpenAIJsonOptions {
  task: OpenAITask;
  systemPrompt: string;
  userPrompt: string;
  schema: JsonSchemaSpec;
  /** 省略すると送らない(モデルの既定値を使う)。 */
  temperature?: number;
  maxOutputTokens: number;
  /** 再試行も含めた全体の上限(ミリ秒)。 */
  timeoutMs: number;
  /** 再試行の最大回数(既定1)。 */
  maxRetries?: number;
  /** 再試行までの待ち時間の基準値(ミリ秒)。通常は変更不要。 */
  retryBaseDelayMs?: number;
}

export interface OpenAIUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface OpenAIJsonResult<T> {
  data: T;
  model: string;
  usage: OpenAIUsage | null;
  latencyMs: number;
  attempts: number;
}

export type OpenAICallErrorKind =
  | "config"
  | "timeout"
  | "rate_limited"
  | "api_error"
  | "refusal"
  | "invalid_response";

export class OpenAICallError extends Error {
  constructor(
    message: string,
    readonly kind: OpenAICallErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenAICallError";
  }
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_BASE_DELAY_MS = 800;
// 待ち時間を差し引いた残り時間がこれ未満なら、再試行しても間に合わないので諦める。
const MIN_ATTEMPT_BUDGET_MS = 1_000;

interface ChatCompletionPayload {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

type AttemptOutcome<T> =
  | { ok: true; data: T; usage: OpenAIUsage | null }
  | { ok: false; error: OpenAICallError; retryable: boolean };

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function timeoutError(): OpenAICallError {
  return new OpenAICallError("OpenAI呼び出しがタイムアウトしました。", "timeout");
}

function buildRequestBody(model: string, options: CallOpenAIJsonOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_completion_tokens: options.maxOutputTokens,
    messages: [
      { role: "system", content: options.systemPrompt },
      { role: "user", content: options.userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: options.schema.name, strict: true, schema: options.schema.schema },
    },
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  return body;
}

function extractUsage(payload: ChatCompletionPayload): OpenAIUsage | null {
  const input = payload.usage?.prompt_tokens;
  const output = payload.usage?.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  return { inputTokens: input, outputTokens: output };
}

function parseCompletion<T>(payload: ChatCompletionPayload): AttemptOutcome<T> {
  const choice = payload.choices?.[0];
  const message = choice?.message;

  if (typeof message?.refusal === "string" && message.refusal.length > 0) {
    return {
      ok: false,
      error: new OpenAICallError("OpenAIが応答を拒否しました。", "refusal"),
      retryable: false,
    };
  }
  if (choice?.finish_reason === "length") {
    return {
      ok: false,
      error: new OpenAICallError("OpenAIの応答が出力上限で途中終了しました。", "invalid_response"),
      retryable: false,
    };
  }
  if (typeof message?.content !== "string") {
    return {
      ok: false,
      error: new OpenAICallError("OpenAIの応答形式が不正です。", "invalid_response"),
      retryable: false,
    };
  }

  try {
    return { ok: true, data: JSON.parse(message.content) as T, usage: extractUsage(payload) };
  } catch {
    return {
      ok: false,
      error: new OpenAICallError("OpenAIの応答をJSONとして解析できませんでした。", "invalid_response"),
      retryable: false,
    };
  }
}

// OpenAIのエラー応答から code / type だけを取り出す(message はログに出さない)。
async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const payload = (await res.json()) as { error?: { code?: unknown; type?: unknown } };
    const code = payload?.error?.code ?? payload?.error?.type;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

async function attemptOnce<T>(
  apiKey: string,
  body: string,
  timeoutMs: number,
  task: OpenAITask,
): Promise<AttemptOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isAbortError(err)) return { ok: false, error: timeoutError(), retryable: false };
    return {
      ok: false,
      error: new OpenAICallError("OpenAI呼び出しに失敗しました。", "api_error"),
      retryable: true,
    };
  }

  if (!res.ok) {
    const code = await readErrorCode(res);
    console.warn("OpenAI API error", { task, status: res.status, code });
    return {
      ok: false,
      error: new OpenAICallError(
        `OpenAI APIがエラーを返しました (status ${res.status})`,
        res.status === 429 ? "rate_limited" : "api_error",
        res.status,
      ),
      retryable: RETRYABLE_STATUSES.has(res.status),
    };
  }

  let payload: ChatCompletionPayload;
  try {
    payload = (await res.json()) as ChatCompletionPayload;
  } catch (err) {
    if (isAbortError(err)) return { ok: false, error: timeoutError(), retryable: false };
    return {
      ok: false,
      error: new OpenAICallError("OpenAIの応答形式が不正です。", "invalid_response"),
      retryable: false,
    };
  }
  return parseCompletion<T>(payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * JSON Schema(strict)で構造化された応答を返すChat Completions呼び出し。
 * 失敗時は OpenAICallError(kind で原因を区別)を投げる。
 */
export async function callOpenAIJson<T>(options: CallOpenAIJsonOptions): Promise<OpenAIJsonResult<T>> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = resolveOpenAIModel(options.task);
  if (!apiKey || !model) {
    throw new OpenAICallError("OPENAI_API_KEY / OPENAI_MODEL が設定されていません。", "config");
  }

  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const body = JSON.stringify(buildRequestBody(model, options));

  let lastError: OpenAICallError = timeoutError();
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    const outcome = await attemptOnce<T>(apiKey, body, remainingMs, options.task);
    if (outcome.ok) {
      return {
        data: outcome.data,
        model,
        usage: outcome.usage,
        latencyMs: Date.now() - startedAt,
        attempts: attempt,
      };
    }

    lastError = outcome.error;
    if (!outcome.retryable || attempt > maxRetries) break;

    const delayMs = baseDelayMs * 2 ** (attempt - 1);
    if (deadline - Date.now() - delayMs < MIN_ATTEMPT_BUDGET_MS) break;
    await sleep(delayMs);
  }
  throw lastError;
}
