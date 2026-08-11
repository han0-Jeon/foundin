// LLM 러너 추상화 — 오케스트레이션은 코드가 쥐고, 러너는 "프롬프트 → 텍스트" 만 담당한다.
// solar: Upstage API (기본 solar-pro4 — 정식 출시 전까지 무료. 구 solar-open2 는 2026-08-04 자정 종료)
// claude-code / codex: 구독 CLI 서브프로세스 (무과금 원칙 — 무료 체험 종료 후 폴백)

export interface CompleteRequest {
  system?: string;
  user: string;
  /** JSON 응답을 기대함 (지원 시 response_format 사용, 미지원 모델은 프롬프트로만 유도) */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /**
   * 추론 강도 (Solar 전용, 지원 모델만). 생략하면 러너 기본값(UPSTAGE_REASONING_EFFORT),
   * null 이면 이 호출만 추론 없이. 다른 러너는 무시한다.
   */
  reasoningEffort?: "low" | "medium" | "high" | null;
  /**
   * 호출 중 상태 보고 (선택). CLI 진행 표시가 이걸 받아 "지금 뭘 하는 중인지" 를 띄운다.
   *
   * 추출 한 번이 몇 분씩 걸리는데 그동안 화면에 아무 변화가 없으면 멈춘 걸로 보인다.
   * 여기서 흘리는 건 전부 실제 상태다 — 응답 대기, 잘린 응답 재시도, 추론 예산 증량,
   * 혼잡 백오프. 진행률처럼 보이는 값을 지어내지 않는다.
   */
  onActivity?: (message: string) => void;
}

export interface LlmRunner {
  name: string;
  complete(req: CompleteRequest): Promise<string>;
}

export type RunnerKind = "solar" | "claude-code" | "codex";

export async function createRunner(kind?: string): Promise<LlmRunner> {
  const resolved = (kind ?? process.env.FOUNDIN_RUNNER ?? "solar") as RunnerKind;
  switch (resolved) {
    case "solar": {
      const { SolarRunner } = await import("./solar.js");
      return new SolarRunner();
    }
    case "claude-code":
    case "codex": {
      const { CliRunner } = await import("./cli-runner.js");
      return new CliRunner(resolved);
    }
    default:
      throw new Error(`unknown runner: ${resolved} (solar | claude-code | codex)`);
  }
}
