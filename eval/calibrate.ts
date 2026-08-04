// Solar 캘리브레이션 — 키 수령 직후 / 모델 교체 직후 1회 실행해 오케스트레이션 파라미터를 확정한다.
//   npm run calibrate
// 측정: ① 한국어 기본 응답 ② JSON 스키마 준수율 ③ 장문 컨텍스트 ④ 지연시간 ⑤ tool calling 지원 여부

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv } from "../src/env.js";
import { htmlToText } from "../src/collect/html.js";
import { SolarRunner } from "../src/llm/solar.js";
import { classificationSchema } from "../src/types.js";

loadDotEnv();

if (!process.env.UPSTAGE_API_KEY) {
  console.error("UPSTAGE_API_KEY 가 없습니다. .env 에 키를 넣고 다시 실행하세요.");
  process.exit(1);
}

const fixtureText = htmlToText(readFileSync(join(import.meta.dirname, "../fixtures/sample-notice.html"), "utf8"));
const lines: string[] = [
  `# ${process.env.UPSTAGE_MODEL ?? "solar-pro4"} 캘리브레이션 리포트`,
  ``,
  `실행: ${new Date().toISOString()}`,
  ``,
];
const runner = new SolarRunner();

function record(line: string): void {
  console.log(line);
  lines.push(line);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}

// ① 한국어 기본
{
  const { value, ms } = await timed(() =>
    runner.complete({ user: "대한민국 정부지원사업 공고에서 '예비창업자'의 일반적 정의를 두 문장으로 설명하라.", maxTokens: 300 }),
  );
  record(`## ① 한국어 기본 응답 (${ms}ms)`);
  record(value.trim().slice(0, 300));
  record("");
}

// ② JSON 스키마 준수율 (분류 태스크 5회)
{
  record(`## ② JSON 스키마 준수율`);
  let passed = 0;
  const latencies: number[] = [];
  for (let i = 0; i < 5; i++) {
    const { value, ms } = await timed(() =>
      runner.complete({
        system: `공고 감별사. JSON 만 출력: {"is_program": boolean, "reason": str, "title": str|null, "organizer": str|null}`,
        user: `다음이 지원사업 공고인지 판정하라:\n${fixtureText.slice(0, 3000)}`,
        json: true,
        maxTokens: 400,
      }),
    );
    latencies.push(ms);
    try {
      const trimmed = value.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "");
      const parsed = classificationSchema.safeParse(JSON.parse(trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)));
      if (parsed.success && parsed.data.is_program) passed++;
    } catch {
      /* 실패 카운트 */
    }
  }
  record(`- 5회 중 ${passed}회 스키마 통과 (지연: ${latencies.map((l) => `${l}ms`).join(", ")})`);
  record("");
}

// ③ 장문 컨텍스트 (약 30K chars)
{
  const longDoc = Array.from({ length: 12 }, (_, i) => `[더미 섹션 ${i}]\n${fixtureText}`).join("\n\n");
  const { value, ms } = await timed(() =>
    runner.complete({
      user: `다음 문서에서 "접수 마감일"을 YYYY-MM-DD 로만 답하라.\n\n${longDoc.slice(0, 30_000)}`,
      maxTokens: 100,
    }),
  );
  record(`## ③ 장문 컨텍스트 (~30K chars, ${ms}ms)`);
  record(`- 응답: ${value.trim().slice(0, 100)}`);
  record(`- 기대: 2026-08-14 ${value.includes("2026-08-14") ? "→ 통과" : "→ 실패"}`);
  record("");
}

// ④ tool calling 지원 여부 (raw API)
{
  record(`## ④ tool calling 프로브`);
  try {
    const response = await fetch(`${(process.env.UPSTAGE_BASE_URL ?? "https://api.upstage.ai/v1").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.UPSTAGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.UPSTAGE_MODEL ?? "solar-pro4",
        messages: [{ role: "user", content: "서울의 오늘 날씨를 조회하라" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "도시의 날씨 조회",
              parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
            },
          },
        ],
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      record(`- HTTP ${response.status} → tools 파라미터 미지원 가능성: ${(await response.text()).slice(0, 200)}`);
    } else {
      const data = (await response.json()) as { choices?: { message?: { tool_calls?: unknown[] } }[] };
      const toolCalls = data.choices?.[0]?.message?.tool_calls;
      record(toolCalls?.length ? `- tool_calls 반환됨 → 지원` : `- 오류 없이 응답했지만 tool_calls 없음 → 프롬프트 JSON 방식 유지 권장`);
    }
  } catch (error) {
    record(`- 프로브 실패: ${error instanceof Error ? error.message : error}`);
  }
  record("");
}

record(`## 결론 메모`);
record(`- 오케스트레이터는 tool calling 없이 동작하도록 설계됨 (프롬프트 JSON + zod 재시도). 위 결과로 파라미터만 조정.`);
writeFileSync(join(import.meta.dirname, "calibration-report.md"), lines.join("\n"), "utf8");
console.log(`\n리포트 저장: eval/calibration-report.md`);
