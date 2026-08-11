// 2회 교차 검증 — 불일치는 "틀림"이 아니라 "모름"으로 내린다 (fail-closed).
// 인용 대조가 못 잡는 오류(실존 문장을 엉뚱한 필드에 붙이기)를 재현성으로 거른다.
import { describe, expect, it } from "vitest";
import { crossCheckExtractions, resolveCrossCheckRuns } from "../src/verify/crosscheck.js";
import { extractionSchema, type Extraction } from "../src/types.js";

const SOURCE = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=1";

function extraction(overrides: Record<string, unknown> = {}): Extraction {
  return extractionSchema.parse({
    overview: {
      title: "2026년 예비창업패키지 모집공고",
      organizer: "중소벤처기업부",
      apply_start: "2026-08-01",
      apply_end: "2026-08-31",
      apply_end_time: "18:00",
      amount_max_krw: 100_000_000,
      amount_note: null,
      support_scale: "40개사",
      self_funding_note: null,
    },
    overview_evidence: [{ field: "apply_end", quote: "접수기간: 2026년 8월 31일까지", source_url: SOURCE }],
    eligibility: {
      allows_pre_startup: true,
      excludes_pre_startup: null,
      requires_business_registration: false,
      min_startup_years: null,
      max_startup_years: 7,
      min_age: null,
      max_age: 39,
      max_revenue_krw: null,
      max_employees: null,
      target_regions: ["서울", "경기"],
      required_certifications: [],
      excluded_targets: ["휴폐업자"],
    },
    eligibility_evidence: [
      { field: "max_age", quote: "만 39세 이하인 자", source_url: SOURCE },
      { field: "max_startup_years", quote: "창업 7년 이내 기업", source_url: SOURCE },
    ],
    requirements: [
      { text: "예비창업자", evidence: { quote: "신청 자격은 예비창업자에 한한다", source_url: SOURCE }, branch_advice: null },
      { text: "서울 소재", evidence: { quote: "서울시에 주소를 둔 자", source_url: SOURCE }, branch_advice: null },
    ],
    exclusions: [],
    documents: [],
    schedule: [],
    risk_points: [],
    confidence: 0.8,
    ...overrides,
  });
}

describe("교차 검증 — 합의된 값만 남긴다", () => {
  it("두 번 같으면 전부 살아남는다", () => {
    const { merged, report } = crossCheckExtractions(extraction(), extraction());
    expect(merged.overview.amount_max_krw).toBe(100_000_000);
    expect(merged.eligibility.max_age).toBe(39);
    expect(merged.requirements).toHaveLength(2);
    expect(report.fields_agreed).toBe(report.fields_checked);
    expect(report.items_agreed).toBe(2);
    expect(report.dropped).toEqual([]);
  });

  it("값이 갈리면 null 로 내리고 위치를 남긴다 — 둘 중 하나를 고르지 않는다", () => {
    const second = extraction();
    second.overview.amount_max_krw = 50_000_000;
    second.eligibility.max_age = 34;
    const { merged, report } = crossCheckExtractions(extraction(), second);
    expect(merged.overview.amount_max_krw).toBeNull();
    expect(merged.eligibility.max_age).toBeNull();
    expect(report.dropped).toContain("overview.amount_max_krw");
    expect(report.dropped).toContain("eligibility.max_age");
    // 일치한 값은 그대로 남는다
    expect(merged.overview.apply_end).toBe("2026-08-31");
    expect(merged.eligibility.max_startup_years).toBe(7);
  });

  it("내려간 값의 근거 인용은 함께 지운다 — 값 없는 인용이 브리프에 떠 있으면 안 된다", () => {
    const second = extraction();
    second.eligibility.max_age = 34;
    const { merged } = crossCheckExtractions(extraction(), second);
    expect(merged.eligibility_evidence.map((e) => e.field)).toEqual(["max_startup_years"]);
  });

  it("한쪽에만 나온 항목은 뺀다", () => {
    const second = extraction();
    second.requirements = [second.requirements[0]!];
    const { merged, report } = crossCheckExtractions(extraction(), second);
    expect(merged.requirements).toHaveLength(1);
    expect(merged.requirements[0]!.text).toBe("예비창업자");
    expect(report.dropped).toContain("requirements[1]");
  });

  it("인용 범위가 달라도 같은 문장이면 같은 항목이다 (표현 차이로 항목을 잃지 않는다)", () => {
    const second = extraction();
    second.requirements[0]!.text = "예비창업자만 신청 가능";
    second.requirements[0]!.evidence.quote = "신청 자격은 예비창업자에 한한다. 기존 사업자는 제외";
    const { merged, report } = crossCheckExtractions(extraction(), second);
    expect(merged.requirements).toHaveLength(2);
    expect(report.items_agreed).toBe(2);
  });

  it("배열 필드는 교집합 — 한쪽에만 있는 지역은 뺀다", () => {
    const second = extraction();
    second.eligibility.target_regions = ["서울", "부산"];
    const { merged, report } = crossCheckExtractions(extraction(), second);
    expect(merged.eligibility.target_regions).toEqual(["서울"]);
    expect(report.dropped.some((d) => d.startsWith("eligibility.target_regions"))).toBe(true);
  });

  it("제목은 대조하지 않는다 — 표기 차이로 브리프가 제목을 잃으면 안 된다", () => {
    const second = extraction();
    second.overview.title = "예비창업패키지 모집공고";
    const { merged, report } = crossCheckExtractions(extraction(), second);
    expect(merged.overview.title).toBe("2026년 예비창업패키지 모집공고");
    expect(report.dropped).not.toContain("overview.title");
  });

  it("확신도는 낮은 쪽을 따른다", () => {
    const second = extraction();
    second.confidence = 0.4;
    const { merged } = crossCheckExtractions(extraction(), second);
    expect(merged.confidence).toBe(0.4);
  });

  it("한쪽만 값이 있으면(다른 쪽 null) 불일치로 본다 — 근거가 한 번뿐이다", () => {
    const second = extraction();
    second.overview.support_scale = null;
    const { merged } = crossCheckExtractions(extraction(), second);
    expect(merged.overview.support_scale).toBeNull();
  });
});

describe("FOUNDIN_CROSS_CHECK 해석", () => {
  it("기본·off·1 은 끔", () => {
    expect(resolveCrossCheckRuns(undefined)).toBe(1);
    expect(resolveCrossCheckRuns("")).toBe(1);
    expect(resolveCrossCheckRuns("off")).toBe(1);
    expect(resolveCrossCheckRuns("1")).toBe(1);
  });

  it("2 는 교차 검증", () => {
    expect(resolveCrossCheckRuns("2")).toBe(2);
  });

  it("지원하지 않는 값은 막는다 (3회는 구현돼 있지 않다)", () => {
    expect(() => resolveCrossCheckRuns("3")).toThrow(/1\(끔\) 또는 2/);
    expect(() => resolveCrossCheckRuns("yes")).toThrow(/FOUNDIN_CROSS_CHECK/);
  });
});
