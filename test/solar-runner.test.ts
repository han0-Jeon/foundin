// SolarRunner 의 오류 안내 — 무료 기간이 끝난 뒤 클론해 돌리는 사람을 위한 것.
// 네트워크는 fetch 스텁으로 대체한다 (오프라인 테스트 원칙 유지).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveReasoningEffort, SolarRunner } from "../src/llm/solar.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.UPSTAGE_API_KEY;
const ORIGINAL_MODEL = process.env.UPSTAGE_MODEL;
const ORIGINAL_EFFORT = process.env.UPSTAGE_REASONING_EFFORT;

function stubFetch(status: number, body: string): void {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
}

/** 요청 본문을 모으면서 순서대로 응답을 돌려주는 스텁 */
function recordingFetch(responses: { status: number; body: string }[]): Record<string, unknown>[] {
  const sent: Record<string, unknown>[] = [];
  let call = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const next = responses[Math.min(call++, responses.length - 1)]!;
    return new Response(next.body, { status: next.status });
  }) as unknown as typeof fetch;
  return sent;
}

const okBody = JSON.stringify({ choices: [{ message: { content: "네" }, finish_reason: "stop" }] });

beforeEach(() => {
  process.env.UPSTAGE_API_KEY = "test-key";
  process.env.UPSTAGE_MODEL = "solar-pro4";
  delete process.env.UPSTAGE_REASONING_EFFORT;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.UPSTAGE_API_KEY;
  else process.env.UPSTAGE_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_MODEL === undefined) delete process.env.UPSTAGE_MODEL;
  else process.env.UPSTAGE_MODEL = ORIGINAL_MODEL;
  if (ORIGINAL_EFFORT === undefined) delete process.env.UPSTAGE_REASONING_EFFORT;
  else process.env.UPSTAGE_REASONING_EFFORT = ORIGINAL_EFFORT;
});

describe("키가 없으면 생성 시점에 막는다", () => {
  it("UPSTAGE_API_KEY 없으면 throw (데모가 후보를 불러오기 전에 걸린다)", () => {
    delete process.env.UPSTAGE_API_KEY;
    expect(() => new SolarRunner()).toThrow(/UPSTAGE_API_KEY/);
  });
});

describe("모델을 쓸 수 없을 때의 안내 (무료 기간 종료 대비)", () => {
  it("404 면 모델명·콘솔·러너 교체를 함께 안내한다", async () => {
    stubFetch(404, JSON.stringify({ error: { message: "model not found" } }));
    const runner = new SolarRunner();
    await expect(runner.complete({ user: "안녕" })).rejects.toThrow(/solar-pro4/);
    await expect(runner.complete({ user: "안녕" })).rejects.toThrow(/console\.upstage\.ai/);
  });

  // 2026-08-04 전환: .env 를 안 고친 사람이 가장 흔한 실패 경로다.
  it("구 모델명(solar-open2)이 남아 있으면 후속 모델과 고칠 위치를 짚어 준다", async () => {
    process.env.UPSTAGE_MODEL = "solar-open2";
    stubFetch(404, JSON.stringify({ error: { message: "model not found" } }));
    const runner = new SolarRunner();
    await expect(runner.complete({ user: "안녕" })).rejects.toThrow(/solar-pro4/);
    await expect(runner.complete({ user: "안녕" })).rejects.toThrow(/UPSTAGE_MODEL/);
  });

  it("모델 관련 400 도 같은 안내로 잡는다", async () => {
    stubFetch(400, JSON.stringify({ error: { message: "unsupported model" } }));
    const runner = new SolarRunner();
    await expect(runner.complete({ user: "안녕" })).rejects.toThrow(/console\.upstage\.ai/);
  });

  it("베타 종료 가능성과 구독 러너 폴백을 알려준다", async () => {
    stubFetch(404, "model not found");
    const runner = new SolarRunner();
    await expect(runner.complete({ user: "안녕" })).rejects.toThrow(/FOUNDIN_RUNNER/);
  });

  it("모델과 무관한 4xx 는 원래 오류를 그대로 낸다 (엉뚱한 안내 금지)", async () => {
    stubFetch(403, "forbidden: quota exhausted");
    const runner = new SolarRunner();
    await expect(runner.complete({ user: "안녕" })).rejects.toThrow(/HTTP 403/);
  });
});

// pro4 는 8/6 리비전부터 reasoning_effort 를 명시해야 생각한다 (2026-08-11 실측).
// 안 보내면 reasoning_tokens=0 이라, "켜졌는지"가 조용히 어긋나면 배치 전체가 헛돈다.
describe("추론 강도 (UPSTAGE_REASONING_EFFORT)", () => {
  it("값 해석 — low/medium/high 는 그대로, off 계열은 미전송", () => {
    expect(resolveReasoningEffort("high")).toBe("high");
    expect(resolveReasoningEffort(" Medium ")).toBe("medium");
    expect(resolveReasoningEffort(undefined)).toBeNull();
    expect(resolveReasoningEffort("")).toBeNull();
    expect(resolveReasoningEffort("off")).toBeNull();
  });

  it("오타는 조용히 무시하지 않고 생성 시점에 막는다", () => {
    expect(() => resolveReasoningEffort("hight")).toThrow(/low \| medium \| high \| off/);
    process.env.UPSTAGE_REASONING_EFFORT = "maximum";
    expect(() => new SolarRunner()).toThrow(/UPSTAGE_REASONING_EFFORT/);
  });

  it("기본값은 미전송 — 켠 적 없는 동작을 바꾸지 않는다", async () => {
    const sent = recordingFetch([{ status: 200, body: okBody }]);
    await new SolarRunner().complete({ user: "안녕" });
    expect(sent[0]).not.toHaveProperty("reasoning_effort");
  });

  it("env 를 켜면 모든 호출에 실린다", async () => {
    process.env.UPSTAGE_REASONING_EFFORT = "high";
    const sent = recordingFetch([{ status: 200, body: okBody }]);
    await new SolarRunner().complete({ user: "안녕" });
    expect(sent[0]?.reasoning_effort).toBe("high");
  });

  it("호출별 지정이 env 를 이긴다 (null 이면 그 호출만 끈다)", async () => {
    process.env.UPSTAGE_REASONING_EFFORT = "high";
    const sent = recordingFetch([{ status: 200, body: okBody }]);
    const runner = new SolarRunner();
    await runner.complete({ user: "안녕", reasoningEffort: "low" });
    await runner.complete({ user: "안녕", reasoningEffort: null });
    expect(sent[0]?.reasoning_effort).toBe("low");
    expect(sent[1]).not.toHaveProperty("reasoning_effort");
  });

  it("모델이 거부하면 끄고 계속한다 — 추론은 품질 옵션이지 전제가 아니다", async () => {
    process.env.UPSTAGE_REASONING_EFFORT = "high";
    const sent = recordingFetch([
      { status: 400, body: JSON.stringify({ error: { message: "unsupported parameter: reasoning_effort" } }) },
      { status: 200, body: okBody },
    ]);
    const runner = new SolarRunner();
    await expect(runner.complete({ user: "안녕" })).resolves.toBe("네");
    expect(sent[0]?.reasoning_effort).toBe("high");
    expect(sent[1]).not.toHaveProperty("reasoning_effort");
    // 한 번 거부당하면 이후 호출에서도 다시 시도하지 않는다
    await runner.complete({ user: "안녕" });
    expect(sent[2]).not.toHaveProperty("reasoning_effort");
  });
});
