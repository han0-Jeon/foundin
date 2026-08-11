// 스키마 v3 후보 대량 검증 — facts-first-spec §8-2 (vibebuilder repo).
//   npm run eval:v3 -- --urls eval/v3-urls.txt [--concurrency 3] [--out eval/schema-v3-report.md]
//
// 무엇을 재나: 12필드가 "사람" 조건은 담지만 "사업" 조건을 못 담는다는 발견(발행 915건 전수 빈도
// 분석, 2026-08-06)에 대해 §8-2 가 제안한 3필드가 **실제로 채워지고 근거가 붙는지**를 본다.
//   target_industries[] · company_scale(소상공인|중소기업|무관) · org_type(개인|법인|무관)
//
// 판단 기준은 두 개다. 채움률만 높고 근거가 없으면 그건 모델이 상식으로 메운 것이고,
// "무관"이 압도적이면 필드를 만들어도 매칭에서 아무것도 못 가른다 (판별력 0).
//
// **DB 기록·발행을 하지 않는다.** 착수 승인 전 단계의 측정 전용이다 (§8: "설계만, 구현은 별도 승인").

import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { collectDocuments } from "../src/collect/index.js";
import { loadDotEnv } from "../src/env.js";
import { createRunner } from "../src/llm/runner.js";
import { buildQuoteIndex, quoteExists } from "../src/verify/quotes.js";
import { renderDocuments } from "../src/agent/prompts.js";
import type { SourceDocument } from "../src/types.js";

const COMPANY_SCALES = ["소상공인", "중소기업", "무관"] as const;
const ORG_TYPES = ["개인", "법인", "무관"] as const;

const v3Schema = z.object({
  target_industries: z.array(z.string().min(1).max(40)).max(12).default([]),
  company_scale: z.enum(COMPANY_SCALES),
  org_type: z.enum(ORG_TYPES),
  evidence: z
    .array(z.object({ field: z.string().min(1).max(40), quote: z.string().min(4).max(400) }))
    .max(12)
    .default([]),
});
type V3 = z.infer<typeof v3Schema>;

const V3_SYSTEM = `너는 한국 정부지원사업 공고를 정독하는 심사역이다.
공고 문서에서 **신청 대상의 사업 속성** 세 가지만 뽑는다. 규칙:

1. 문서에 명시된 것만. 추측·업계 상식으로 채우지 않는다. 명시가 없으면 "무관"·빈 배열이다.
   "무관"은 "제한 문구를 찾지 못했다"는 뜻이지 "모든 업종 환영"이라는 뜻이 아니다.
2. target_industries: 지원 대상 업종·특화 분야. 공고가 업종을 제한하거나 특정 분야를 지정한
   경우에만 넣는다 (예: "제조업", "관광", "콘텐츠", "바이오", "소프트웨어"). 명사구로 짧게.
   제외 업종(유흥·사행성 등 상용구)은 넣지 않는다 — 그건 거의 모든 공고에 있어 판별력이 없다.
3. company_scale: 소상공인 | 중소기업 | 무관.
   "소상공인기본법", "소상공인 대상" 이면 소상공인. "중소기업기본법 제2조", "중소기업 대상"이면 중소기업.
   둘 다 명시가 없으면 무관.
4. org_type: 개인 | 법인 | 무관. "법인사업자에 한함" 이면 법인, "개인사업자만" 이면 개인, 없으면 무관.
5. evidence: "무관"·빈 배열이 아닌 값마다 근거 인용을 넣는다 (field 는 위 키 이름).
   quote 는 원문에서 **글자 그대로 복사**한다. 기계가 원문과 문자 단위로 대조하므로
   요약·의역·어순 변경은 그 항목을 통째로 버리게 만든다.

JSON 만 출력한다. 마크다운 펜스 금지. 형식:
{"target_industries": [str], "company_scale": "소상공인"|"중소기업"|"무관",
 "org_type": "개인"|"법인"|"무관", "evidence": [{"field": str, "quote": str}]}`;

interface Outcome {
  url: string;
  ok: boolean;
  reason?: string;
  v3?: V3;
  /** 근거가 원문 대조를 통과한 필드 */
  verified?: Set<string>;
}

function stripToJson(raw: string): string {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("응답에서 JSON 객체를 찾지 못함");
  return trimmed.slice(start, end + 1);
}

async function analyzeOne(url: string, runner: { name: string; complete: (r: { system: string; user: string; json: boolean; maxTokens: number; temperature: number }) => Promise<string> }): Promise<Outcome> {
  let documents: SourceDocument[];
  try {
    documents = (await collectDocuments(url, {})).documents;
  } catch (error) {
    return { url, ok: false, reason: `collect: ${error instanceof Error ? error.message : error}` };
  }
  if (documents.length === 0) return { url, ok: false, reason: "collect: 문서 없음" };

  let v3: V3;
  try {
    const raw = await runner.complete({
      system: V3_SYSTEM,
      user: `다음 공고 문서들에서 사업 속성 3필드를 추출하라.\n\n${renderDocuments(documents)}`,
      json: true,
      maxTokens: 1500,
      temperature: 0.1,
    });
    v3 = v3Schema.parse(JSON.parse(stripToJson(raw)));
  } catch (error) {
    return { url, ok: false, reason: `extract: ${String(error instanceof Error ? error.message : error).slice(0, 120)}` };
  }

  const index = buildQuoteIndex(documents);
  const verified = new Set<string>();
  for (const item of v3.evidence) {
    if (quoteExists(item.quote, index)) verified.add(item.field);
  }
  return { url, ok: true, v3, verified };
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "N/A" : `${((part / whole) * 100).toFixed(1)}%`;
}

export function renderReport(outcomes: Outcome[]): string {
  const ok = outcomes.filter((o) => o.ok && o.v3);
  const total = ok.length;

  const industriesFilled = ok.filter((o) => o.v3!.target_industries.length > 0);
  const scaleFilled = ok.filter((o) => o.v3!.company_scale !== "무관");
  const orgFilled = ok.filter((o) => o.v3!.org_type !== "무관");

  const verifiedOf = (rows: Outcome[], field: string) => rows.filter((o) => o.verified!.has(field)).length;

  const scaleDist = new Map<string, number>();
  const orgDist = new Map<string, number>();
  const industryFreq = new Map<string, number>();
  for (const o of ok) {
    scaleDist.set(o.v3!.company_scale, (scaleDist.get(o.v3!.company_scale) ?? 0) + 1);
    orgDist.set(o.v3!.org_type, (orgDist.get(o.v3!.org_type) ?? 0) + 1);
    for (const industry of o.v3!.target_industries) {
      industryFreq.set(industry, (industryFreq.get(industry) ?? 0) + 1);
    }
  }

  const failures = outcomes.filter((o) => !o.ok);
  const topIndustries = [...industryFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  return [
    `# 스키마 v3 후보 검증 리포트 (facts-first §8-2)`,
    ``,
    `실행: ${new Date().toISOString()} · 표본 ${outcomes.length}건 (분석 성공 ${total} · 실패 ${failures.length})`,
    ``,
    `> 측정 전용입니다. DB 기록·발행을 하지 않습니다.`,
    ``,
    `## 필드별 채움률과 근거`,
    ``,
    `| 필드 | 값 있음 | 비율 | 근거 대조 통과 | 근거율 |`,
    `| --- | ---: | ---: | ---: | ---: |`,
    `| target_industries | ${industriesFilled.length} | ${pct(industriesFilled.length, total)} | ${verifiedOf(industriesFilled, "target_industries")} | ${pct(verifiedOf(industriesFilled, "target_industries"), industriesFilled.length)} |`,
    `| company_scale | ${scaleFilled.length} | ${pct(scaleFilled.length, total)} | ${verifiedOf(scaleFilled, "company_scale")} | ${pct(verifiedOf(scaleFilled, "company_scale"), scaleFilled.length)} |`,
    `| org_type | ${orgFilled.length} | ${pct(orgFilled.length, total)} | ${verifiedOf(orgFilled, "org_type")} | ${pct(verifiedOf(orgFilled, "org_type"), orgFilled.length)} |`,
    ``,
    `"값 있음" = "무관"·빈 배열이 아닌 것. 근거율이 낮으면 모델이 상식으로 메웠다는 뜻이라 필드로 쓸 수 없습니다.`,
    ``,
    `## 값 분포 (판별력)`,
    ``,
    `- company_scale: ${[...scaleDist.entries()].map(([k, v]) => `${k} ${v}`).join(" · ")}`,
    `- org_type: ${[...orgDist.entries()].map(([k, v]) => `${k} ${v}`).join(" · ")}`,
    ``,
    `한 값이 압도적이면 필드를 만들어도 매칭에서 공고를 가르지 못합니다.`,
    ``,
    `## 업종 상위 ${topIndustries.length}`,
    ``,
    ...(topIndustries.length > 0
      ? topIndustries.map(([name, count]) => `- ${count}건 · ${name}`)
      : ["- (없음)"]),
    ``,
    `어휘가 얼마나 흩어지는지가 관건입니다 — 같은 업종이 여러 표기로 갈리면 선택지(대분류)로 못 만듭니다.`,
    `서로 다른 업종 라벨 ${industryFreq.size}종.`,
    ``,
    `## 분석 실패 ${failures.length}건`,
    ``,
    ...(failures.length > 0 ? failures.slice(0, 10).map((f) => `- ${f.reason} — ${f.url}`) : ["- (없음)"]),
    ``,
  ].join("\n");
}

async function main(): Promise<number> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const urlsFile = flag("urls");
  const concurrency = Math.max(1, Number(flag("concurrency") ?? 3));
  const out = flag("out") ?? "eval/schema-v3-report.md";
  if (!urlsFile) {
    console.error("사용법: npm run eval:v3 -- --urls eval/v3-urls.txt [--concurrency 3] [--out ...]");
    return 1;
  }

  const urls = (await readFile(urlsFile, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const runner = await createRunner();
  console.error(`스키마 v3 검증 — ${urls.length}건 · ${runner.name} · 동시성 ${concurrency}`);

  const outcomes: Outcome[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= urls.length) return;
        const outcome = await analyzeOne(urls[index]!, runner as never);
        outcomes.push(outcome);
        console.error(`[${outcomes.length}/${urls.length}] ${outcome.ok ? "ok" : `실패(${outcome.reason?.slice(0, 40)})`} — ${urls[index]}`);
      }
    }),
  );

  await writeFile(out, renderReport(outcomes), "utf8");
  if (runner.name.startsWith("solar")) {
    const { formatSolarUsage, getSolarUsage } = await import("../src/llm/solar.js");
    if (getSolarUsage().calls > 0) console.log(`토큰 ${formatSolarUsage()}`);
  }
  console.log(`리포트 저장: ${out}`);
  return 0;
}

const invokedDirectly = process.argv[1] ? /schema-v3\.(ts|js)$/.test(process.argv[1].replace(/\\/g, "/")) : false;
if (invokedDirectly) process.exit(await main());
