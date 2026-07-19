import { z } from "zod";
import { collectDocuments } from "../collect/index.js";
import type { GuardedFetchOptions } from "../collect/fetch.js";
import type { LlmRunner } from "../llm/runner.js";
import {
  adviceSchema,
  classificationSchema,
  extractionSchema,
  type AnalysisResult,
  type Brief,
  type Extraction,
  type SourceDocument,
} from "../types.js";
import { verifyExtraction } from "../verify/index.js";
import { ADVISE_SYSTEM, CLASSIFY_SYSTEM, EXTRACT_SYSTEM, adviseUser, classifyUser, extractUser } from "./prompts.js";

export interface AnalyzeDeps {
  runner: LlmRunner;
  fetchOptions?: GuardedFetchOptions;
  onStep?: (step: string, detail?: string) => void;
  /** 테스트 주입용 */
  collectImpl?: typeof collectDocuments;
  /** 인용 검증 실패 시 재추출 횟수 (기본 1) */
  maxRepair?: number;
}

function stripToJson(raw: string): string {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("응답에서 JSON 객체를 찾지 못함");
  return trimmed.slice(start, end + 1);
}

async function completeJson<T>(
  runner: LlmRunner,
  request: { system: string; user: string; maxTokens?: number },
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  retries = 2,
): Promise<T> {
  let user = request.user;
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await runner.complete({
      system: request.system,
      user,
      json: true,
      maxTokens: request.maxTokens,
      temperature: 0.1,
    });
    try {
      const parsed = schema.safeParse(JSON.parse(stripToJson(raw)));
      if (parsed.success) return parsed.data;
      lastError = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    user = `${request.user}\n\n[파싱 실패 재시도] 이전 응답이 유효하지 않았다: ${lastError}\n규칙에 맞는 JSON 하나만 다시 출력하라.`;
  }
  throw new Error(`JSON 응답 파싱 실패: ${lastError}`);
}

function overviewSummary(extraction: Extraction): string {
  const o = extraction.overview;
  return [
    o.organizer ? `주관 ${o.organizer}` : null,
    o.amount_max_krw ? `지원금 최대 ${Math.round(o.amount_max_krw / 10_000).toLocaleString()}만원` : o.amount_note,
    o.support_scale ? `규모 ${o.support_scale}` : null,
    o.apply_end ? `마감 ${o.apply_end}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 공고 URL → 검증된 판단 브리프.
 * 파이프라인: 수집 → 판정 → 추출 → 검증 → (재추출 1회) → 조언 → 조립.
 * 발행 게이트를 통과하지 못하면 브리프를 만들지 않는다 (fail-closed).
 */
export async function analyzeUrl(url: string, deps: AnalyzeDeps): Promise<AnalysisResult> {
  const step = deps.onStep ?? (() => {});
  const collect = deps.collectImpl ?? collectDocuments;

  // 1. 수집
  step("collect", "원문·첨부 수집");
  let documents: SourceDocument[];
  let skipped;
  try {
    const result = await collect(url, deps.fetchOptions ?? {});
    documents = result.documents;
    skipped = result.skipped;
  } catch (error) {
    return {
      ok: false,
      stage: "collect",
      reason: error instanceof Error ? error.message : String(error),
      source_url: url,
    };
  }

  // 2. 공고 판정
  step("classify", "공고 여부 판정");
  let classification;
  try {
    classification = await completeJson(
      deps.runner,
      { system: CLASSIFY_SYSTEM, user: classifyUser(documents), maxTokens: 800 },
      classificationSchema,
    );
  } catch (error) {
    return { ok: false, stage: "classify", reason: String(error instanceof Error ? error.message : error), source_url: url };
  }
  if (!classification.is_program) {
    return { ok: false, stage: "classify", not_a_program: true, reason: classification.reason, source_url: url };
  }

  // 3. 추출 → 4. 검증 (실패 인용은 피드백 삼아 1회 재추출)
  const maxRepair = deps.maxRepair ?? 1;
  let extraction: Extraction | null = null;
  let outcome: ReturnType<typeof verifyExtraction> | null = null;

  for (let round = 0; round <= maxRepair; round++) {
    step("extract", round === 0 ? "조건·날짜·서류 추출" : "검증 실패 항목 재추출");
    let feedback: string | undefined;
    if (round > 0 && outcome && extraction) {
      const failedQuotes = outcome.report.held
        .slice(0, 8)
        .map((location) => `- ${location}`)
        .join("\n");
      feedback = `다음 항목의 인용이 원문 대조에 실패했다:\n${failedQuotes}\n${outcome.report.value_issues.join("\n")}`;
    }
    let latest: Extraction;
    try {
      latest = await completeJson(
        deps.runner,
        { system: EXTRACT_SYSTEM, user: extractUser(documents, feedback), maxTokens: 6000 },
        extractionSchema,
      );
    } catch (error) {
      if (extraction) break; // 재추출 실패면 직전 결과로 진행
      return { ok: false, stage: "extract", reason: String(error instanceof Error ? error.message : error), source_url: url };
    }
    extraction = latest;
    step("verify", "인용·날짜·숫자 원문 대조");
    outcome = verifyExtraction(latest, documents);
    if (outcome.report.publishable || outcome.report.held.length === 0) break;
  }

  if (!extraction || !outcome) {
    return { ok: false, stage: "extract", reason: "추출 결과 없음", source_url: url };
  }
  if (!outcome.report.publishable) {
    return {
      ok: false,
      stage: "verify",
      reason: outcome.report.gate_reason ?? "검증 게이트 미통과",
      source_url: url,
    };
  }

  // 5. 판단 조언 — 검증 통과 요건만 입력 (실패해도 브리프는 발행, why_look 만 비움)
  step("advise", "판단 코멘트 작성");
  let whyLook: string | null = null;
  const adviceByIndex = new Map<number, Record<string, string>>();
  const verifiedRequirements = extraction.requirements
    .map((item, index) => ({ index, text: item.text }))
    .filter(({ index }) => outcome.verdicts.get(`requirements[${index}]`));
  if (verifiedRequirements.length > 0) {
    try {
      const advice = await completeJson(
        deps.runner,
        {
          system: ADVISE_SYSTEM,
          user: adviseUser({
            title: extraction.overview.title,
            requirements: verifiedRequirements,
            overviewSummary: overviewSummary(extraction),
          }),
          maxTokens: 2000,
        },
        adviceSchema,
      );
      whyLook = advice.why_look;
      for (const entry of advice.requirement_advice) {
        adviceByIndex.set(entry.index, entry.branch_advice as Record<string, string>);
      }
    } catch {
      step("advise", "조언 생성 실패 — 브리프는 검증 결과만으로 발행");
    }
  }

  // 6. 조립
  step("assemble", "브리프 조립");
  const stamp = <T>(name: string, items: T[]) =>
    items.map((item, i) => ({ verified: outcome.verdicts.get(`${name}[${i}]`) ?? false, item }));

  const brief: Brief = {
    source_url: url,
    analyzed_at: new Date().toISOString(),
    model: deps.runner.name,
    overview: extraction.overview,
    eligibility: extraction.eligibility,
    why_look: whyLook,
    requirements: extraction.requirements.map((item, i) => ({
      verified: outcome.verdicts.get(`requirements[${i}]`) ?? false,
      item: { ...item, branch_advice: (adviceByIndex.get(i) as never) ?? item.branch_advice },
    })),
    exclusions: stamp("exclusions", extraction.exclusions),
    documents: stamp("documents", extraction.documents),
    schedule: stamp("schedule", extraction.schedule),
    risk_points: stamp("risk_points", extraction.risk_points),
    verification: outcome.report,
    documents_meta: documents.map((document) => ({ url: document.url, kind: document.kind, chars: document.text.length })),
    skipped_attachments: skipped ?? [],
    confidence: extraction.confidence,
  };
  return { ok: true, brief };
}
