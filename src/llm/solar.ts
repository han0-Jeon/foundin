import type { CompleteRequest, LlmRunner } from "./runner.js";

// Upstage Solar API — OpenAI 호환 chat completions.
// 한도: 400 RPM / 150K TPM (2026-08-11 응답 헤더 실측, commitment tier default). 429·5xx 는 지수 백오프로 재시도.
//
// ⚠ Solar 는 추론(reasoning) 모델이다 (solar-open2 2026-07-19 · solar-pro4 2026-08-04 실측):
// completion 토큰을 생각에 먼저 소모한 뒤 content 를 쓴다. max_tokens 가 작으면 생각만 하다
// content 가 빈 채로 끝나므로, 호출자가 요청한 본문 예산에 추론 버퍼를 얹고, 비면 늘려 재시도한다.
//
// ⚠⚠ 2026-08-11 실측 — pro4 는 8/6 리비전(solar-pro4-260806)부터 **기본이 추론 끄기**다.
// reasoning_effort 를 안 보내면 reasoning_tokens=0 이고 message.reasoning 자체가 없다.
// 즉 8/6 이후 우리 파이프라인은 추론 없는 pro4 로 돌고 있었다. 켜려면 명시해야 한다:
//   UPSTAGE_REASONING_EFFORT=low|medium|high  (기본 off — 켠 적 없는 동작을 유지)
// 켜면 생각도 completion 토큰이라 위 추론 버퍼 로직이 그대로 안전망이 된다.

const MAX_ATTEMPTS = 3;
const REASONING_BUFFER_BASE = 4096;
const REASONING_BUFFER_MAX = 32768;
// 장문 추출(입력 26K + 생각 + 긴 JSON)은 3분을 넘길 수 있다 — 100건 실측에서 180초 타임아웃 19건
const REQUEST_TIMEOUT_MS = 300_000;

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/**
 * 프로세스 누적 토큰 사용량. 배치를 몇 시간 돌린 뒤 "얼마나 썼나"를 콘솔 대시보드가 아니라
 * 실행 로그에서 바로 읽으려고 둔다. 재시도분도 그대로 더한다 — 청구되는 건 그쪽이다.
 */
export interface SolarUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

const usage: SolarUsage = { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };

function recordUsage(raw: {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
} | undefined): void {
  usage.calls += 1;
  usage.promptTokens += raw?.prompt_tokens ?? 0;
  usage.completionTokens += raw?.completion_tokens ?? 0;
  usage.reasoningTokens += raw?.completion_tokens_details?.reasoning_tokens ?? 0;
}

export function getSolarUsage(): SolarUsage {
  return { ...usage };
}

/** 90% 할인가 (2026-08-11 ~ 09-11): input $0.03 / output $0.12 per 1M */
const PRICE_INPUT_PER_M = Number(process.env.UPSTAGE_PRICE_INPUT ?? 0.03);
const PRICE_OUTPUT_PER_M = Number(process.env.UPSTAGE_PRICE_OUTPUT ?? 0.12);

export function formatSolarUsage(u: SolarUsage = getSolarUsage()): string {
  const cost = (u.promptTokens * PRICE_INPUT_PER_M + u.completionTokens * PRICE_OUTPUT_PER_M) / 1_000_000;
  const reasoningShare = u.completionTokens > 0 ? (u.reasoningTokens / u.completionTokens) * 100 : 0;
  return (
    `호출 ${u.calls.toLocaleString()} · 입력 ${u.promptTokens.toLocaleString()} · ` +
    `출력 ${u.completionTokens.toLocaleString()} (생각 ${u.reasoningTokens.toLocaleString()}, ${reasoningShare.toFixed(0)}%) · ` +
    `추정 $${cost.toFixed(4)}`
  );
}

export type ReasoningEffort = "low" | "medium" | "high";

const EFFORT_VALUES: readonly string[] = ["low", "medium", "high"];

/**
 * UPSTAGE_REASONING_EFFORT 해석. 빈 값·off·false 는 "보내지 않음"(=모델 기본값).
 * 오타는 조용히 무시하지 않고 막는다 — 배치를 몇 시간 돌린 뒤에야 "안 켜졌네"를 아는 게 최악이다.
 */
export function resolveReasoningEffort(raw: string | undefined): ReasoningEffort | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "off" || value === "false" || value === "none") return null;
  if (EFFORT_VALUES.includes(value)) return value as ReasoningEffort;
  throw new Error(
    `UPSTAGE_REASONING_EFFORT 값이 잘못됐습니다: '${raw}'. low | medium | high | off 중 하나여야 합니다.`,
  );
}

export class SolarRunner implements LlmRunner {
  readonly name: string;
  private baseUrl: string;
  private apiKey: string;
  /** 베타 모델이 response_format 을 거부하면 이후 호출부터 생략 */
  private supportsResponseFormat = true;
  /** 모델이 reasoning_effort 를 거부하면(구 모델·mini) 이후 호출부터 생략 */
  private supportsReasoningEffort = true;
  /** 기본 추론 강도 — null 이면 파라미터를 아예 보내지 않는다 */
  private readonly defaultEffort: ReasoningEffort | null;

  constructor() {
    this.apiKey = process.env.UPSTAGE_API_KEY ?? "";
    if (!this.apiKey) {
      throw new Error("UPSTAGE_API_KEY 가 없습니다. .env 를 확인하세요 (.env.example 참고).");
    }
    this.baseUrl = (process.env.UPSTAGE_BASE_URL ?? "https://api.upstage.ai/v1").replace(/\/$/, "");
    this.name = process.env.UPSTAGE_MODEL ?? "solar-pro4";
    this.defaultEffort = resolveReasoningEffort(process.env.UPSTAGE_REASONING_EFFORT);
  }

  async complete(req: CompleteRequest): Promise<string> {
    const messages: ChatMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.user });

    const report = req.onActivity ?? (() => {});
    const inputChars = (req.system?.length ?? 0) + req.user.length;

    const effort = req.reasoningEffort === undefined ? this.defaultEffort : req.reasoningEffort;

    let lastError = "";
    let reasoningBuffer = REASONING_BUFFER_BASE;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const body: Record<string, unknown> = {
        model: this.name,
        messages,
        temperature: req.temperature ?? 0.2,
        max_tokens: (req.maxTokens ?? 4096) + reasoningBuffer,
      };
      if (req.json && this.supportsResponseFormat) {
        body.response_format = { type: "json_object" };
      }
      if (effort && this.supportsReasoningEffort) {
        body.reasoning_effort = effort;
      }

      report(
        attempt === 1
          ? `${this.name} 응답 대기 — 원문 ${inputChars.toLocaleString()}자 전송`
          : `${this.name} 응답 대기 (${attempt}/${MAX_ATTEMPTS}회차)`,
      );

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        lastError = `network: ${error instanceof Error ? error.message : String(error)}`;
        report(`응답 없음 — 잠시 후 재시도 (${attempt}/${MAX_ATTEMPTS})`);
        await backoff(attempt);
        continue;
      }

      if (response.ok) {
        const data = (await response.json()) as {
          choices?: { message?: { content?: string }; finish_reason?: string }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
          };
        };
        recordUsage(data.usage);
        const choice = data.choices?.[0];
        const content = choice?.message?.content;
        // finish_reason=length 면 content 가 있어도 잘린 JSON — 파서로 넘기지 않고 버퍼 증량 재시도.
        // (100건 실측: 잘린 JSON 이 파싱 단계까지 흘러가 "JSON 파싱 실패"로 죽던 케이스)
        const truncated = choice?.finish_reason === "length";
        if (typeof content === "string" && content.trim() && !truncated) {
          report(`응답 수신 ${content.length.toLocaleString()}자 — 구조 파싱`);
          return content;
        }
        lastError = truncated
          ? "truncated content (finish_reason=length)"
          : `empty content (finish_reason=${choice?.finish_reason ?? "?"})`;
        // 추론이 예산을 다 먹은 경우 — 버퍼를 키워 즉시 재시도 (백오프 불필요)
        reasoningBuffer = Math.min(reasoningBuffer * 2, REASONING_BUFFER_MAX);
        report(
          truncated
            ? `응답이 잘려서 토큰 예산 ${reasoningBuffer.toLocaleString()} 로 늘려 재시도`
            : `추론이 예산을 다 써 빈 응답 — 버퍼 ${reasoningBuffer.toLocaleString()} 로 재시도`,
        );
        continue;
      }

      const errorText = (await response.text()).slice(0, 500);
      // 베타에서 response_format 미지원일 수 있음 — 한 번 끄고 즉시 재시도
      if (response.status === 400 && req.json && this.supportsResponseFormat && /response_format/i.test(errorText)) {
        this.supportsResponseFormat = false;
        attempt--;
        continue;
      }
      // reasoning_effort 는 pro4 계열만 받는다 — 구 모델·mini 로 폴백한 키는 여기서 걸린다.
      // 끄고 계속: 추론 강도는 품질 옵션이지 파이프라인의 전제가 아니다.
      if (response.status === 400 && effort && this.supportsReasoningEffort && /reasoning_effort/i.test(errorText)) {
        this.supportsReasoningEffort = false;
        report(`${this.name} 이 reasoning_effort 를 받지 않아 끄고 계속합니다`);
        attempt--;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = `HTTP ${response.status}: ${errorText}`;
        report(
          response.status === 429
            ? `요청 한도 초과 — 백오프 후 재시도 (${attempt}/${MAX_ATTEMPTS})`
            : `서버 오류 ${response.status} — 백오프 후 재시도 (${attempt}/${MAX_ATTEMPTS})`,
        );
        await backoff(attempt);
        continue;
      }
      // 모델 전환 완료 (Upstage 공지 2026-08-03): solar-open2 는 8/4 자정에 alias 삭제됐고
      // 후속은 solar-pro4 다. 구 모델명을 그대로 둔 .env 로 돌리면 여기로 떨어지므로,
      // "모델 없음" 오류에 무엇을 바꿔야 하는지를 함께 실어 보낸다.
      if (response.status === 404 || (response.status === 400 && /model/i.test(errorText))) {
        const hint =
          this.name === "solar-pro4"
            ? "solar-pro4 는 정식 출시 전까지 무료 체험으로 열려 있습니다 — 체험이 끝났거나 키 권한이 없을 수 있습니다. "
            : "후속 모델은 'solar-pro4' 입니다 (.env 의 UPSTAGE_MODEL 을 바꿔 주세요). " +
              "solar-open2 는 2026-08-04 자정에 삭제됐습니다. ";
        throw new Error(
          `모델 '${this.name}' 을 쓸 수 없습니다 (HTTP ${response.status}). ` +
            hint +
            "쓸 수 있는 모델은 console.upstage.ai 에서 확인하실 수 있습니다. " +
            "구독 CLI 로 갈아타려면 FOUNDIN_RUNNER=claude-code 또는 codex.",
        );
      }
      throw new Error(`Solar API HTTP ${response.status}: ${errorText}`);
    }
    throw new Error(`Solar API 실패 (${MAX_ATTEMPTS}회 시도): ${lastError}`);
  }
}

async function backoff(attempt: number): Promise<void> {
  const ms = Math.min(30_000, 2_000 * 2 ** (attempt - 1)) + Math.random() * 1_000;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
