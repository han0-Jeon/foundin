// 결정적 검증 5단계 중 2~5단계 (1단계 zod 스키마는 파싱 시점에 수행).
//  2. 인용 대조: 모든 evidence quote 가 원문에 실존하는지
//  3. 값 대조: 마감일·지원금이 자기 근거 인용에서 재도출되는지
//  4. 충돌 검사: 문서 간 마감일 불일치
//  5. 발행 게이트: 핵심 필드(마감·자격) 실패 시 브리프 전체 미발행 (fail-closed)

import type { Extraction, SourceDocument, VerificationReport } from "../types.js";
import { buildQuoteIndex, quoteExists } from "./quotes.js";
import { amountMatchesQuote, dateMatchesQuote, parseKoreanDates } from "./values.js";

export interface VerificationOutcome {
  report: VerificationReport;
  /** location → 검증 통과 여부. 항목 렌더링 시 verified 스탬프로 사용 */
  verdicts: Map<string, boolean>;
}

const CORE_REQUIREMENT_PASS_RATE = 0.6;
const OVERALL_QUOTE_PASS_RATE = 0.5;

export function verifyExtraction(extraction: Extraction, documents: SourceDocument[]): VerificationOutcome {
  const index = buildQuoteIndex(documents);
  const verdicts = new Map<string, boolean>();
  const held: string[] = [];
  const valueIssues: string[] = [];
  const conflicts: string[] = [];
  let quotesTotal = 0;
  let quotesPassed = 0;

  const checkQuote = (location: string, quote: string | undefined): boolean => {
    if (!quote) return false;
    quotesTotal++;
    const ok = quoteExists(quote, index);
    if (ok) quotesPassed++;
    return ok;
  };

  // ── 섹션 항목 인용 대조 ──
  const sections = [
    ["requirements", extraction.requirements],
    ["exclusions", extraction.exclusions],
    ["documents", extraction.documents],
    ["schedule", extraction.schedule],
    ["risk_points", extraction.risk_points],
  ] as const;

  for (const [name, items] of sections) {
    items.forEach((item, i) => {
      const location = `${name}[${i}]`;
      const evidence = "evidence" in item ? item.evidence : null;
      if (!evidence) {
        // 근거 없는 항목은 발행은 하되 "원문 확인 필요" 표시 (requirements 는 스키마상 근거 필수)
        verdicts.set(location, false);
        return;
      }
      const ok = checkQuote(location, evidence.quote);
      verdicts.set(location, ok);
      if (!ok) held.push(location);
    });
  }

  // ── overview 값 대조 (마감일·지원금은 근거 + 값 재도출까지 요구) ──
  const evidenceByField = new Map<string, { quote: string; source_url: string }[]>();
  for (const entry of extraction.overview_evidence) {
    const list = evidenceByField.get(entry.field) ?? [];
    list.push({ quote: entry.quote, source_url: entry.source_url });
    evidenceByField.set(entry.field, list);
  }

  const checkOverviewField = (
    field: "apply_end" | "apply_start" | "amount_max_krw" | "support_scale",
    value: string | number | null,
    validate?: (quote: string) => boolean,
  ) => {
    const location = `overview.${field}`;
    if (value === null || value === undefined) return;
    const evidences = evidenceByField.get(field) ?? [];
    if (evidences.length === 0) {
      verdicts.set(location, false);
      held.push(location);
      if (field === "apply_end" || field === "amount_max_krw") valueIssues.push(`${location}: 근거 인용 없음`);
      return;
    }
    let fieldOk = false;
    for (const evidence of evidences) {
      const exists = checkQuote(location, evidence.quote);
      const valueOk = validate ? validate(evidence.quote) : true;
      if (exists && valueOk) fieldOk = true;
      if (exists && !valueOk) valueIssues.push(`${location}: 값이 인용문과 불일치`);
    }
    verdicts.set(location, fieldOk);
    if (!fieldOk) held.push(location);
  };

  checkOverviewField("apply_end", extraction.overview.apply_end, (quote) =>
    extraction.overview.apply_end ? dateMatchesQuote(extraction.overview.apply_end, quote) : false,
  );
  checkOverviewField("apply_start", extraction.overview.apply_start, (quote) =>
    extraction.overview.apply_start ? dateMatchesQuote(extraction.overview.apply_start, quote) : false,
  );
  checkOverviewField("amount_max_krw", extraction.overview.amount_max_krw, (quote) =>
    extraction.overview.amount_max_krw !== null ? amountMatchesQuote(extraction.overview.amount_max_krw, quote) : false,
  );
  checkOverviewField("support_scale", extraction.overview.support_scale);

  // ── 문서 간 충돌: apply_end 근거들이 서로 다른 날짜를 가리키는가 ──
  const applyEndEvidences = evidenceByField.get("apply_end") ?? [];
  if (extraction.overview.apply_end && applyEndEvidences.length > 1) {
    const distinctFullDates = new Set<string>();
    for (const evidence of applyEndEvidences) {
      // 범위 표기("‘26. 7. 20. ~ ’26. 8. 4.")는 마지막 완전 날짜가 마감 —
      // 시작일까지 모으면 정상 범위 인용끼리도 충돌로 오판하므로 인용당 하나만 대표로 쓴다
      const fullDates = parseKoreanDates(evidence.quote).filter((parsed) => parsed.year !== null);
      const last = fullDates[fullDates.length - 1];
      if (last) distinctFullDates.add(`${last.year}-${last.month}-${last.day}`);
    }
    if (distinctFullDates.size > 1) {
      conflicts.push(`apply_end: 문서 간 마감일 상이 (${[...distinctFullDates].join(" vs ")})`);
    }
  }

  // ── 발행 게이트 (fail-closed) ──
  let gateReason: string | null = null;
  const requirementTotal = extraction.requirements.length;
  const requirementPassed = extraction.requirements.filter((_, i) => verdicts.get(`requirements[${i}]`)).length;

  if (requirementTotal === 0) {
    gateReason = "자격 요건을 하나도 추출하지 못함";
  } else if (requirementPassed / requirementTotal < CORE_REQUIREMENT_PASS_RATE) {
    gateReason = `자격 요건 인용 검증 통과율 미달 (${requirementPassed}/${requirementTotal})`;
  } else if (extraction.overview.apply_end && verdicts.get("overview.apply_end") === false) {
    gateReason = "마감일을 원문에서 검증하지 못함";
  } else if (conflicts.length > 0) {
    gateReason = conflicts[0] ?? "문서 간 충돌";
  } else if (quotesTotal > 0 && quotesPassed / quotesTotal < OVERALL_QUOTE_PASS_RATE) {
    gateReason = `전체 인용 검증 통과율 미달 (${quotesPassed}/${quotesTotal})`;
  }

  return {
    report: {
      quotes_total: quotesTotal,
      quotes_passed: quotesPassed,
      held,
      value_issues: valueIssues,
      conflicts,
      publishable: gateReason === null,
      gate_reason: gateReason,
    },
    verdicts,
  };
}
