// SolarRunner 의 오류 안내 — 베타 종료(2026-08-01) 후 클론해 돌리는 사람을 위한 것.
// 네트워크는 fetch 스텁으로 대체한다 (오프라인 테스트 원칙 유지).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SolarRunner } from "../src/llm/solar.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.UPSTAGE_API_KEY;
const ORIGINAL_MODEL = process.env.UPSTAGE_MODEL;

function stubFetch(status: number, body: string): void {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.UPSTAGE_API_KEY = "test-key";
  process.env.UPSTAGE_MODEL = "solar-open2";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.UPSTAGE_API_KEY;
  else process.env.UPSTAGE_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_MODEL === undefined) delete process.env.UPSTAGE_MODEL;
  else process.env.UPSTAGE_MODEL = ORIGINAL_MODEL;
});

describe("키가 없으면 생성 시점에 막는다", () => {
  it("UPSTAGE_API_KEY 없으면 throw (데모가 후보를 불러오기 전에 걸린다)", () => {
    delete process.env.UPSTAGE_API_KEY;
    expect(() => new SolarRunner()).toThrow(/UPSTAGE_API_KEY/);
  });
});

describe("모델을 쓸 수 없을 때의 안내 (베타 종료 대비)", () => {
  it("404 면 모델명·콘솔·러너 교체를 함께 안내한다", async () => {
    stubFetch(404, JSON.stringify({ error: { message: "model not found" } }));
    const runner = new SolarRunner();
    await expect(runner.complete({ user: "안녕" })).rejects.toThrow(/solar-open2/);
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
