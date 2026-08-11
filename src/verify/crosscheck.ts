// 2회 교차 검증 — 같은 원문을 독립 2회 추출해, 두 번 다 같은 값이 나온 것만 남긴다.
// (한영 결정 2026-08-11: 크레딧을 품질로 바꾼다)
//
// 왜 인용 대조만으로 부족한가: 기존 게이트는 "인용이 원문에 실존하는가"를 본다. 그래서
// 없는 문장을 지어내는 건 잡히지만, **실존하는 문장을 엉뚱한 필드에 붙이는 것**은 통과한다.
// 예: "만 39세 이하"가 다른 트랙 조건인데 max_age 로 올라오는 경우 — 인용은 원문에 있다.
// 이런 오답은 재현되지 않는 경향이 있어(모델이 매번 같은 오해를 하지는 않는다),
// 두 번 돌려 일치하는 값만 남기면 걸러진다.
//
// 원칙은 기존과 같다 — 불일치는 "틀린 값"이 아니라 "모름"으로 내린다(fail-closed).
// 값을 null 로 비우면 브리프는 그 자리를 "원문 확인 필요"로 렌더하고,
// buildInquiryQuestions 가 기관에 물을 질문을 만든다.
//
// 적용 경계 (2026-08-11 실전 3건 측정으로 정함):
//   **값(스칼라·배열)만 지운다. 항목 리스트는 재현 여부를 재기만 한다.**
// 항목까지 같은 규칙으로 지웠더니 한 공고에서 요건 5개 중 4개가 사라졌다. 오답이라서가
// 아니라 두 번째 실행이 같은 요건을 다른 문장으로 인용하거나 다르게 쪼갰기 때문이다.
// 항목은 이미 "인용이 원문에 실존하는가" 게이트가 지키고 있고, 교차 검증이 맡아야 할
// 실패 모드(실존 문장을 엉뚱한 필드·숫자에 붙이기)는 값 쪽에서 일어난다.

import type { Evidence, Extraction } from "../types.js";
import { normalizeForMatch } from "./quotes.js";

export interface CrossCheckReport {
  /** 몇 번 돌렸나 (2 이상일 때만 이 리포트가 붙는다) */
  runs: number;
  /** 값이 있어 대조 대상이 된 필드 수 / 그중 일치한 수 */
  fields_checked: number;
  fields_agreed: number;
  /** 항목 리스트: 1차에 있던 개수 / 두 번 다 나온 개수 (측정만 — 항목은 지우지 않는다) */
  items_checked: number;
  items_agreed: number;
  /** 불일치로 **내린** 값의 위치 ("overview.amount_max_krw", "eligibility.max_age") */
  dropped: string[];
  /**
   * 재현되지 않은 항목의 위치 ("requirements[2]"). **지우지 않고 알리기만 한다.**
   *
   * 2026-08-11 실전 3건 측정에서 정한 경계다. 값(스칼라)은 두 번 다 같아야 남기지만,
   * 항목까지 같은 규칙으로 지우면 브리프가 텅 빈다 — 한 공고에서 요건 5개 중 4개가
   * 사라졌다. 원인은 오답이 아니라 표현 차이다: 같은 요건을 두 번째 실행이 다른 문장으로
   * 인용하거나 다르게 쪼개면 짝이 안 맞는다.
   * 항목은 이미 "인용이 원문에 실존하는가" 게이트를 통과한 것들이라 방어선이 따로 있다.
   * 교차 검증이 실제로 잡아야 하는 건 인용 대조가 못 잡는 쪽 — 실존 문장을 엉뚱한
   * 필드·숫자에 붙이는 것 — 이고, 그건 스칼라 값에서 일어난다.
   */
  unstable_items: string[];
}

/** 인용 두 개가 "같은 문장을 가리키는가" — 모델마다 인용 범위가 조금씩 다르므로 포함 관계로 본다. */
function sameQuote(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = normalizeForMatch(a);
  const y = normalizeForMatch(b);
  if (x.length < 4 || y.length < 4) return false;
  return x.includes(y) || y.includes(x);
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return normalizeForMatch(a) === normalizeForMatch(b);
}

/** 스칼라 동치 — 숫자·불리언은 엄격히, 문자열은 정규화 후 비교. */
function sameScalar(a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (typeof a === "string" && typeof b === "string") return sameText(a, b);
  return a === b;
}

/** 배열 필드는 교집합 — 한쪽에만 나온 항목은 근거가 약하다고 보고 뺀다. */
function intersect(a: string[], b: string[]): string[] {
  const other = new Set(b.map((value) => normalizeForMatch(value)));
  return a.filter((value) => other.has(normalizeForMatch(value)));
}

interface ItemLike {
  text?: string;
  name?: string;
  label?: string;
  date_text?: string;
  evidence?: Evidence | null;
}

/** 항목 동일성: 인용이 같은 문장을 가리키면 같은 항목. 인용이 없으면 표시 문자열로 비교. */
function sameItem(a: ItemLike, b: ItemLike): boolean {
  if (a.evidence?.quote && b.evidence?.quote) return sameQuote(a.evidence.quote, b.evidence.quote);
  const left = a.text ?? a.name ?? `${a.label ?? ""} ${a.date_text ?? ""}`.trim();
  const right = b.text ?? b.name ?? `${b.label ?? ""} ${b.date_text ?? ""}`.trim();
  return sameText(left, right);
}

const OVERVIEW_CHECKED = [
  "organizer",
  "apply_start",
  "apply_end",
  "apply_end_time",
  "amount_max_krw",
  "amount_note",
  "support_scale",
  "self_funding_note",
] as const;

const ELIGIBILITY_SCALARS = [
  "allows_pre_startup",
  "excludes_pre_startup",
  "requires_business_registration",
  "min_startup_years",
  "max_startup_years",
  "min_age",
  "max_age",
  "max_revenue_krw",
  "max_employees",
] as const;

const ELIGIBILITY_ARRAYS = ["target_regions", "required_certifications", "excluded_targets"] as const;

const LIST_FIELDS = ["requirements", "exclusions", "documents", "schedule", "risk_points"] as const;

/**
 * 1차 추출을 기준으로 2차와 대조해 합의된 것만 남긴 추출을 만든다.
 *
 * title 은 대조하지 않는다 — 표기 차이("2026년 ○○ 모집공고" vs "○○ 모집공고")로 브리프가
 * 제목을 잃으면 안 되고, 제목은 판단을 좌우하는 값이 아니다.
 */
export function crossCheckExtractions(primary: Extraction, second: Extraction): {
  merged: Extraction;
  report: CrossCheckReport;
} {
  const dropped: string[] = [];
  let fieldsChecked = 0;
  let fieldsAgreed = 0;

  const overview = { ...primary.overview };
  for (const field of OVERVIEW_CHECKED) {
    if (overview[field] === null || overview[field] === undefined) continue;
    fieldsChecked += 1;
    if (sameScalar(overview[field], second.overview[field])) {
      fieldsAgreed += 1;
    } else {
      (overview[field] as unknown) = null;
      dropped.push(`overview.${field}`);
    }
  }

  const eligibility = { ...primary.eligibility };
  for (const field of ELIGIBILITY_SCALARS) {
    if (eligibility[field] === null || eligibility[field] === undefined) continue;
    fieldsChecked += 1;
    if (sameScalar(eligibility[field], second.eligibility[field])) {
      fieldsAgreed += 1;
    } else {
      (eligibility[field] as unknown) = null;
      dropped.push(`eligibility.${field}`);
    }
  }
  for (const field of ELIGIBILITY_ARRAYS) {
    const mine = eligibility[field] ?? [];
    if (mine.length === 0) continue;
    fieldsChecked += 1;
    const kept = intersect(mine, second.eligibility[field] ?? []);
    eligibility[field] = kept;
    if (kept.length === mine.length) fieldsAgreed += 1;
    else dropped.push(`eligibility.${field}[-${mine.length - kept.length}]`);
  }

  const merged = { ...primary, overview, eligibility } as Extraction;

  // 항목은 재현 여부를 재기만 하고 지우지 않는다 (위 unstable_items 주석의 근거).
  let itemsChecked = 0;
  let itemsAgreed = 0;
  const unstableItems: string[] = [];
  for (const field of LIST_FIELDS) {
    const mine = (primary[field] ?? []) as ItemLike[];
    const theirs = (second[field] ?? []) as ItemLike[];
    mine.forEach((item, index) => {
      itemsChecked += 1;
      if (theirs.some((other) => sameItem(item, other))) itemsAgreed += 1;
      else unstableItems.push(`${field}[${index}]`);
    });
  }

  // 살아남은 필드의 근거만 남긴다 — 내려간 값의 인용이 브리프에 떠 있으면 안 된다.
  const survivingOverview = new Set(
    OVERVIEW_CHECKED.filter((f) => overview[f] !== null && overview[f] !== undefined) as string[],
  );
  survivingOverview.add("title");
  merged.overview_evidence = (primary.overview_evidence ?? []).filter((e) => survivingOverview.has(e.field));

  const survivingEligibility = new Set<string>([
    ...ELIGIBILITY_SCALARS.filter((f) => eligibility[f] !== null && eligibility[f] !== undefined),
    ...ELIGIBILITY_ARRAYS.filter((f) => (eligibility[f] ?? []).length > 0),
  ]);
  merged.eligibility_evidence = (primary.eligibility_evidence ?? []).filter((e) =>
    survivingEligibility.has(e.field),
  );

  // 확신도는 낮은 쪽을 따른다 — 두 번 중 덜 확신한 쪽이 이 브리프의 실제 확신도다.
  merged.confidence = Math.min(primary.confidence, second.confidence);

  return {
    merged,
    report: {
      runs: 2,
      fields_checked: fieldsChecked,
      fields_agreed: fieldsAgreed,
      items_checked: itemsChecked,
      items_agreed: itemsAgreed,
      dropped,
      unstable_items: unstableItems,
    },
  };
}

/** FOUNDIN_CROSS_CHECK 해석 — 1(기본)이면 끔, 2 면 2회 교차 검증. */
export function resolveCrossCheckRuns(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (!value || value === "off" || value === "1" || value === "false") return 1;
  const parsed = Number(value);
  if (parsed === 2) return 2;
  throw new Error(`FOUNDIN_CROSS_CHECK 값이 잘못됐습니다: '${raw}'. 1(끔) 또는 2 만 지원합니다.`);
}
