import type { CompleteRequest, LlmRunner } from "./runner.js";

// Upstage Solar API — OpenAI 호환 chat completions.
// 베타 한도: 400 RPM / 150K TPM. 429·5xx 는 지수 백오프로 재시도.

const MAX_ATTEMPTS = 3;

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export class SolarRunner implements LlmRunner {
  readonly name: string;
  private baseUrl: string;
  private apiKey: string;
  /** 베타 모델이 response_format 을 거부하면 이후 호출부터 생략 */
  private supportsResponseFormat = true;

  constructor() {
    this.apiKey = process.env.UPSTAGE_API_KEY ?? "";
    if (!this.apiKey) {
      throw new Error("UPSTAGE_API_KEY 가 없습니다. .env 를 확인하세요 (.env.example 참고).");
    }
    this.baseUrl = (process.env.UPSTAGE_BASE_URL ?? "https://api.upstage.ai/v1").replace(/\/$/, "");
    this.name = process.env.UPSTAGE_MODEL ?? "solar-open2";
  }

  async complete(req: CompleteRequest): Promise<string> {
    const messages: ChatMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.user });

    let lastError = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const body: Record<string, unknown> = {
        model: this.name,
        messages,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 4096,
      };
      if (req.json && this.supportsResponseFormat) {
        body.response_format = { type: "json_object" };
      }

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });
      } catch (error) {
        lastError = `network: ${error instanceof Error ? error.message : String(error)}`;
        await backoff(attempt);
        continue;
      }

      if (response.ok) {
        const data = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content === "string" && content.trim()) return content;
        lastError = "empty completion content";
        await backoff(attempt);
        continue;
      }

      const errorText = (await response.text()).slice(0, 500);
      // 베타에서 response_format 미지원일 수 있음 — 한 번 끄고 즉시 재시도
      if (response.status === 400 && req.json && this.supportsResponseFormat && /response_format/i.test(errorText)) {
        this.supportsResponseFormat = false;
        attempt--;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = `HTTP ${response.status}: ${errorText}`;
        await backoff(attempt);
        continue;
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
