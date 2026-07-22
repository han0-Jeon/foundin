import { z } from "zod";
import { collectDocuments } from "../collect/index.js";
import type { GuardedFetchOptions } from "../collect/fetch.js";
import { precheck, type PrecheckDeps } from "../collect/precheck.js";
import type { LlmRunner } from "../llm/runner.js";
import {
  adviceSchema,
  classificationSchema,
  extractionSchema,
  type AnalysisResult,
  type Brief,
  type DomainTier,
  type Extraction,
  type PresetDocument,
  type SourceDocument,
} from "../types.js";
import { buildInquiryQuestions } from "../brief/inquiry.js";
import { verifyExtraction } from "../verify/index.js";
import { ADVISE_SYSTEM, CLASSIFY_SYSTEM, EXTRACT_SYSTEM, adviseUser, classifyUser, extractUser } from "./prompts.js";

/** STAGE A(수집·연락처·프리체크·판정) 완료 시점의 중간 보고. 워커가 서버로 전달한다. */
export interface StageAInfo {
  is_program: boolean;
  tier: DomainTier;
  reason?: string;
}

export interface AnalyzeDeps {
  runner: LlmRunner;
  fetchOptions?: GuardedFetchOptions;
  /** 서버(claim)가 동봉한 사전 수집 문서 — 수집기가 자체 결과에 병합한다 */
  presetDocuments?: PresetDocument[];
  onStep?: (step: string, detail?: string) => void;
  /** STAGE A 완료(공고 여부 확정) 시 1회 호출 — 워커의 중간 보고 훅 */
  onStageA?: (info: StageAInfo) => void | Promise<void>;
  /** 테스트 주입용 */
  collectImpl?: typeof collectDocuments;
  /** 테스트 주입용 — 프리체크 대체 */
  precheckImpl?: typeof precheck;
  /** 프리체크 옵션 (도메인 나이 조회 등) */
  precheckDeps?: PrecheckDeps;
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
  let rawDocuments: SourceDocument[];
  let skipped;
  let contact = null;
  try {
    const result = await collect(url, { ...(deps.fetchOptions ?? {}), presetDocuments: deps.presetDocuments });
    documents = result.documents; // 연락처 마스킹된 텍스트 (Solar 전송용)
    rawDocuments = result.rawDocuments; // 마스킹 전 원문 (로컬 프리체크 전용, Solar 미전송)
    skipped = result.skipped;
    contact = result.contact; // 마스킹 전 연락처 (표시 전용, Solar 미전송)
  } catch (error) {
    return {
      ok: false,
      stage: "collect",
      reason: error instanceof Error ? error.message : String(error),
      source_url: url,
    };
  }

  // 2. 프리체크 (결정적) — 출처 도메인·위험신호로 STAGE A 판정을 가속한다.
  //    pass_fast: Tier1 + 공고 패턴 → Solar 판정 생략 · reject: 비공고 반려 · needs_llm: Solar 판정 수행
  const finalUrl = rawDocuments[0]?.url ?? documents[0]?.url ?? url;
  step("precheck", "출처 도메인·위험신호 프리체크");
  const runPrecheck = deps.precheckImpl ?? precheck;
  const pre = await runPrecheck(finalUrl, rawDocuments, deps.precheckDeps ?? {});
  const tier = pre.tier;

  if (pre.verdict === "reject") {
    await deps.onStageA?.({ is_program: false, tier, reason: pre.reason });
    return { ok: false, stage: "classify", not_a_program: true, reason: pre.reason ?? "프리체크 반려", tier, source_url: url };
  }

  // 3. 공고 판정 — 프리체크가 애매(needs_llm)할 때만 Solar 를 태운다.
  if (pre.verdict === "needs_llm") {
    step("classify", "공고 여부 판정");
    let classification;
    try {
      classification = await completeJson(
        deps.runner,
        { system: CLASSIFY_SYSTEM, user: classifyUser(documents), maxTokens: 800 },
        classificationSchema,
      );
    } catch (error) {
      return { ok: false, stage: "classify", reason: String(error instanceof Error ? error.message : error), tier, source_url: url };
    }
    if (!classification.is_program) {
      await deps.onStageA?.({ is_program: false, tier, reason: classification.reason });
      return { ok: false, stage: "classify", not_a_program: true, reason: classification.reason, tier, source_url: url };
    }
    await deps.onStageA?.({ is_program: true, tier, reason: classification.reason });
  } else {
    step("precheck", pre.reason ?? "공공 도메인 + 공고 패턴 — Solar 판정 생략");
    await deps.onStageA?.({ is_program: true, tier, reason: pre.reason });
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
      const message = String(error instanceof Error ? error.message : error);
      // 강등 재시도: 초대형 문서는 추론 모델이 시간·토큰 예산 안에 못 끝내는 경우가 있다
      // (실측: 특정 장문 공고가 300초 × 3회를 재현성 있게 초과). 입력을 절반으로 줄여
      // 한 번 더 시도한다 — 잘린 만큼은 검증 게이트·"원문 확인 필요" 표기가 안전망.
      if (/timeout|truncated|length/i.test(message)) {
        step("extract", "입력 축소 후 재시도 (장문 문서 시간 초과)");
        try {
          const trimmed = documents
            .slice(0, 3)
            .map((document) => ({ ...document, text: document.text.slice(0, 8_000) }));
          latest = await completeJson(
            deps.runner,
            { system: EXTRACT_SYSTEM, user: extractUser(trimmed, feedback), maxTokens: 6000 },
            extractionSchema,
          );
        } catch (retryError) {
          const retryMessage = String(retryError instanceof Error ? retryError.message : retryError);
          return { ok: false, stage: "extract", reason: `${message} (입력 축소 재시도도 실패: ${retryMessage.slice(0, 120)})`, tier, source_url: url };
        }
      } else {
        return { ok: false, stage: "extract", reason: message, tier, source_url: url };
      }
    }
    extraction = latest;
    step("verify", "인용·날짜·숫자 원문 대조");
    outcome = verifyExtraction(latest, documents);
    if (outcome.report.publishable || outcome.report.held.length === 0) break;
  }

  if (!extraction || !outcome) {
    return { ok: false, stage: "extract", reason: "추출 결과 없음", tier, source_url: url };
  }
  if (!outcome.report.publishable) {
    return {
      ok: false,
      stage: "verify",
      reason: outcome.report.gate_reason ?? "검증 게이트 미통과",
      tier,
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

  const assembled: Omit<Brief, "inquiry_questions"> = {
    source_url: url,
    analyzed_at: new Date().toISOString(),
    model: deps.runner.name,
    tier,
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
    contact, // Solar 미전송 — 우리 코드가 원문에서 직접 추출
    confidence: extraction.confidence,
  };
  // 문의 질문 — 보류·미검증·미확인 지점에서 결정적 생성 (Solar 미호출)
  const brief: Brief = { ...assembled, inquiry_questions: buildInquiryQuestions(assembled) };
  return { ok: true, brief };
}
