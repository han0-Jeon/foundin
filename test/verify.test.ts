import { describe, expect, it } from "vitest";
import { buildQuoteIndex, quoteExists } from "../src/verify/quotes.js";
import { amountMatchesQuote, dateMatchesQuote, parseKrwAmounts } from "../src/verify/values.js";
import { verifyExtraction } from "../src/verify/index.js";
import type { Extraction, SourceDocument } from "../src/types.js";

const doc = (text: string): SourceDocument => ({ url: "https://example.go.kr/notice", kind: "html", title: null, text });

describe("인용 대조", () => {
  it("공백·줄바꿈이 달라도 원문에 있으면 통과", () => {
    const index = buildQuoteIndex([doc("신청 자격:\n공고일   기준 사업자등록을\n완료한 창업 7년 이내 기업")]);
    expect(quoteExists("공고일 기준 사업자등록을 완료한 창업 7년 이내 기업", index)).toBe(true);
  });
  it("원문에 없는 인용은 실패", () => {
    const index = buildQuoteIndex([doc("이 공고는 매출 조건이 없습니다.")]);
    expect(quoteExists("직전년도 매출액 10억원 미만 기업", index)).toBe(false);
  });
});

describe("날짜·금액 재대조", () => {
  it("한국식 날짜 표기 파싱", () => {
    expect(dateMatchesQuote("2026-08-14", "접수기간: 2026. 7. 21.(화) ~ 2026. 8. 14.(금) 16:00")).toBe(true);
    expect(dateMatchesQuote("2026-08-15", "마감: 2026. 8. 14.")).toBe(false);
    expect(dateMatchesQuote("2026-08-14", "8월 14일 마감")).toBe(true);
    expect(dateMatchesQuote("2026-08-14", "2026년 8월 14일까지")).toBe(true);
  });
  it("두 자리 연도 압축 표기 (kocca 접수마감일 표)", () => {
    expect(dateMatchesQuote("2026-07-21", "- 접수마감일 26.07.21")).toBe(true);
    expect(dateMatchesQuote("2011-06-22", "- 접수마감일 11.06.22")).toBe(true);
    expect(dateMatchesQuote("2025-07-21", "- 접수마감일 26.07.21")).toBe(false); // 연도 불일치
  });
  it("굽은 따옴표 두 자리 연도 (HWP·PDF 추출 텍스트)", () => {
    const quote = "□ (접수기간) ‘26. 7. 20.(월) ~ ’26. 8. 4.(화), 15:00까지";
    expect(dateMatchesQuote("2026-07-20", quote)).toBe(true);
    expect(dateMatchesQuote("2026-08-04", quote)).toBe(true);
    expect(dateMatchesQuote("2026-08-05", quote)).toBe(false);
    expect(dateMatchesQuote("2026-07-08", "온라인으로만 신청 가능, 접수마감(‘26.7.8.(수) 16:00) 이후 수정 불가")).toBe(true);
    expect(dateMatchesQuote("2023-05-26", "□신청기간:(당초)‘23.5.26(금)~6.30(금)")).toBe(true);
  });
  it("요일 괄호로 닫히는 월.일 (범위 뒤쪽 표기)", () => {
    expect(dateMatchesQuote("2026-07-21", "신청기간: 2026. 7. 3(금) ~ 7. 21(화) 11:00 까지")).toBe(true);
    expect(dateMatchesQuote("2023-06-30", "□신청기간:(당초)‘23.5.26(금)~6.30(금)")).toBe(true);
    expect(dateMatchesQuote("2026-08-14", "접수: 7. 1.(화) ~ 8. 14.(목) 16:00")).toBe(true);
  });
  it("오파싱 방지 — 날짜 아닌 숫자는 날짜로 해석하지 않음", () => {
    expect(dateMatchesQuote("2001-06-22", "총 사업비 1.06.22")).toBe(false); // 두 자리 세 그룹이 아니면 연도 아님
    expect(dateMatchesQuote("2026-07-21", "규정 제26.07.211호")).toBe(false); // 뒤에 숫자가 이어지면 아님
    expect(dateMatchesQuote("2026-13-05", "26.13.05")).toBe(false); // 월 범위 밖
  });
  it("금액 파싱", () => {
    expect(parseKrwAmounts("기업당 최대 5,000만원")).toContain(50_000_000);
    expect(parseKrwAmounts("최대 1억원 지원")).toContain(100_000_000);
    expect(parseKrwAmounts("1억 5천만원 한도")).toContain(150_000_000);
    expect(amountMatchesQuote(50_000_000, "최대 5,000만원")).toBe(true);
    expect(amountMatchesQuote(60_000_000, "최대 5,000만원")).toBe(false);
  });
});

const baseExtraction = (overrides: Partial<Extraction>): Extraction => ({
  overview: {
    title: "테스트 공고",
    organizer: "테스트기관",
    apply_start: null,
    apply_end: "2026-08-14",
    apply_end_time: "16:00",
    amount_max_krw: 50_000_000,
    amount_note: null,
    support_scale: null,
    self_funding_note: null,
  },
  overview_evidence: [
    { field: "apply_end", quote: "접수기간: 2026. 7. 21.(화) ~ 2026. 8. 14.(금) 16:00", source_url: "https://example.go.kr/notice" },
    { field: "amount_max_krw", quote: "사업화 자금 기업당 최대 5,000만원", source_url: "https://example.go.kr/notice" },
  ],
  eligibility: {
    allows_pre_startup: null,
    excludes_pre_startup: null,
    requires_business_registration: true,
    min_startup_years: null,
    max_startup_years: 7,
    min_age: null,
    max_age: null,
    max_revenue_krw: 1_000_000_000,
    max_employees: null,
    target_regions: ["서울"],
    required_certifications: [],
    excluded_targets: [],
  },
  eligibility_evidence: [],
  requirements: [],
  exclusions: [],
  documents: [],
  schedule: [],
  risk_points: [],
  confidence: 0.9,
  notes: null,
  ...overrides,
});

const noticeText = `접수기간: 2026. 7. 21.(화) ~ 2026. 8. 14.(금) 16:00
사업화 자금 기업당 최대 5,000만원
공고일 기준 사업자등록을 완료한 창업 7년 이내 기업
신청일 기준 본점 또는 주사업장이 서울특별시에 소재한 기업`;

describe("검증 게이트 (fail-closed)", () => {
  it("전부 원문에 있으면 발행 가능", () => {
    const extraction = baseExtraction({
      requirements: [
        {
          text: "창업 7년 이내 기업",
          evidence: { quote: "공고일 기준 사업자등록을 완료한 창업 7년 이내 기업", source_url: "https://example.go.kr/notice" },
          branch_advice: null,
        },
        {
          text: "서울 소재",
          evidence: { quote: "본점 또는 주사업장이 서울특별시에 소재한 기업", source_url: "https://example.go.kr/notice" },
          branch_advice: null,
        },
      ],
    });
    const { report } = verifyExtraction(extraction, [doc(noticeText)]);
    expect(report.publishable).toBe(true);
    expect(report.quotes_passed).toBe(report.quotes_total);
  });

  it("환각 인용이 절반이면 요건 통과율 미달로 미발행", () => {
    const extraction = baseExtraction({
      requirements: [
        {
          text: "창업 7년 이내 기업",
          evidence: { quote: "공고일 기준 사업자등록을 완료한 창업 7년 이내 기업", source_url: "https://example.go.kr/notice" },
          branch_advice: null,
        },
        {
          text: "청년 대표자",
          evidence: { quote: "대표자가 만 39세 이하인 청년 기업", source_url: "https://example.go.kr/notice" },
          branch_advice: null,
        },
      ],
    });
    const { report, verdicts } = verifyExtraction(extraction, [doc(noticeText)]);
    expect(verdicts.get("requirements[1]")).toBe(false);
    expect(report.held).toContain("requirements[1]");
    expect(report.publishable).toBe(false);
    expect(report.gate_reason).toContain("통과율");
  });

  it("금액이 인용문과 다르면 value_issue + 보류", () => {
    const extraction = baseExtraction({
      overview: { ...baseExtraction({}).overview, amount_max_krw: 60_000_000 },
      requirements: [
        {
          text: "창업 7년 이내 기업",
          evidence: { quote: "공고일 기준 사업자등록을 완료한 창업 7년 이내 기업", source_url: "https://example.go.kr/notice" },
          branch_advice: null,
        },
      ],
    });
    const { report } = verifyExtraction(extraction, [doc(noticeText)]);
    expect(report.value_issues.some((issue) => issue.includes("amount_max_krw"))).toBe(true);
    expect(report.held).toContain("overview.amount_max_krw");
  });

  it("범위 인용 여럿이 같은 마감을 가리키면 충돌 아님", () => {
    const rangeText = `□ (공고기간) ‘26. 7. 6.(월) ~ ’26. 8. 4.(화), 15:00까지
□ (접수기간) ‘26. 7. 20.(월) ~ ’26. 8. 4.(화), 15:00까지
사업화 자금 기업당 최대 5,000만원
공고일 기준 사업자등록을 완료한 창업 7년 이내 기업`;
    const extraction = baseExtraction({
      overview: { ...baseExtraction({}).overview, apply_end: "2026-08-04" },
      overview_evidence: [
        { field: "apply_end", quote: "□ (공고기간) ‘26. 7. 6.(월) ~ ’26. 8. 4.(화), 15:00까지", source_url: "https://example.go.kr/notice" },
        { field: "apply_end", quote: "□ (접수기간) ‘26. 7. 20.(월) ~ ’26. 8. 4.(화), 15:00까지", source_url: "https://example.go.kr/notice" },
        { field: "amount_max_krw", quote: "사업화 자금 기업당 최대 5,000만원", source_url: "https://example.go.kr/notice" },
      ],
      requirements: [
        {
          text: "창업 7년 이내 기업",
          evidence: { quote: "공고일 기준 사업자등록을 완료한 창업 7년 이내 기업", source_url: "https://example.go.kr/notice" },
          branch_advice: null,
        },
      ],
    });
    const { report, verdicts } = verifyExtraction(extraction, [doc(rangeText)]);
    expect(verdicts.get("overview.apply_end")).toBe(true);
    expect(report.conflicts).toHaveLength(0);
    expect(report.publishable).toBe(true);
  });

  it("인용들이 다른 마감을 가리키면 충돌로 미발행", () => {
    const conflictText = `□ (공고기간) ‘26. 7. 6.(월) ~ ’26. 8. 4.(화), 15:00까지
연장 공고: 접수 마감 ’26. 8. 28.(금) 15:00까지
사업화 자금 기업당 최대 5,000만원
공고일 기준 사업자등록을 완료한 창업 7년 이내 기업`;
    const extraction = baseExtraction({
      overview: { ...baseExtraction({}).overview, apply_end: "2026-08-04" },
      overview_evidence: [
        { field: "apply_end", quote: "□ (공고기간) ‘26. 7. 6.(월) ~ ’26. 8. 4.(화), 15:00까지", source_url: "https://example.go.kr/notice" },
        { field: "apply_end", quote: "연장 공고: 접수 마감 ’26. 8. 28.(금) 15:00까지", source_url: "https://example.go.kr/notice" },
        { field: "amount_max_krw", quote: "사업화 자금 기업당 최대 5,000만원", source_url: "https://example.go.kr/notice" },
      ],
      requirements: [
        {
          text: "창업 7년 이내 기업",
          evidence: { quote: "공고일 기준 사업자등록을 완료한 창업 7년 이내 기업", source_url: "https://example.go.kr/notice" },
          branch_advice: null,
        },
      ],
    });
    const { report } = verifyExtraction(extraction, [doc(conflictText)]);
    expect(report.conflicts).toHaveLength(1);
    expect(report.publishable).toBe(false);
    expect(report.gate_reason).toContain("마감일 상이");
  });

  it("마감일 근거가 없으면 미발행", () => {
    const extraction = baseExtraction({
      overview_evidence: [
        { field: "amount_max_krw", quote: "사업화 자금 기업당 최대 5,000만원", source_url: "https://example.go.kr/notice" },
      ],
      requirements: [
        {
          text: "창업 7년 이내 기업",
          evidence: { quote: "공고일 기준 사업자등록을 완료한 창업 7년 이내 기업", source_url: "https://example.go.kr/notice" },
          branch_advice: null,
        },
      ],
    });
    const { report } = verifyExtraction(extraction, [doc(noticeText)]);
    expect(report.publishable).toBe(false);
    expect(report.gate_reason).toContain("마감일");
  });
});

describe("자격 필드 판정 (facts-first 1단계 — 그림자)", () => {
  const seoulEvidence = {
    field: "target_regions",
    quote: "본점 또는 주사업장이 서울특별시에 소재한 기업",
    source_url: "https://example.go.kr/notice",
  };
  const passingRequirements = [
    {
      text: "창업 7년 이내 기업",
      evidence: { quote: "공고일 기준 사업자등록을 완료한 창업 7년 이내 기업", source_url: "https://example.go.kr/notice" },
      branch_advice: null,
    },
    {
      text: "서울 소재",
      evidence: { quote: "본점 또는 주사업장이 서울특별시에 소재한 기업", source_url: "https://example.go.kr/notice" },
      branch_advice: null,
    },
  ];

  it("근거가 원문에 실존하면 verified", () => {
    const extraction = baseExtraction({ eligibility_evidence: [seoulEvidence] });
    const { report } = verifyExtraction(extraction, [doc(noticeText)]);
    expect(report.eligibility_verdicts.target_regions).toBe("verified");
  });

  it("값은 있는데 근거가 없으면 unknown", () => {
    const { report } = verifyExtraction(baseExtraction({}), [doc(noticeText)]);
    expect(report.eligibility_verdicts.max_revenue_krw).toBe("unknown");
    expect(report.eligibility_verdicts.requires_business_registration).toBe("unknown");
  });

  it("근거 인용이 원문에 없으면 unknown", () => {
    const extraction = baseExtraction({
      eligibility_evidence: [
        { field: "max_revenue_krw", quote: "직전년도 매출액 10억원 미만 기업", source_url: "https://example.go.kr/notice" },
      ],
    });
    const { report } = verifyExtraction(extraction, [doc(noticeText)]);
    expect(report.eligibility_verdicts.max_revenue_krw).toBe("unknown");
  });

  it("null·빈 배열 필드는 판정 대상이 아니다", () => {
    const { report } = verifyExtraction(baseExtraction({}), [doc(noticeText)]);
    expect(report.eligibility_verdicts).not.toHaveProperty("min_age");
    expect(report.eligibility_verdicts).not.toHaveProperty("required_certifications");
  });

  it("판정은 발행 게이트·인용 카운터에 영향을 주지 않는다", () => {
    const withEvidence = baseExtraction({ requirements: passingRequirements, eligibility_evidence: [seoulEvidence] });
    const withoutEvidence = baseExtraction({ requirements: passingRequirements });
    const a = verifyExtraction(withEvidence, [doc(noticeText)]);
    const b = verifyExtraction(withoutEvidence, [doc(noticeText)]);
    // unknown 이 있어도(매출 10억 무근거) 발행 거동은 기존과 동일
    expect(Object.values(b.report.eligibility_verdicts)).toContain("unknown");
    expect(a.report.publishable).toBe(true);
    expect(b.report.publishable).toBe(true);
    // eligibility 인용은 quotes 카운터에 불산입 — 근거 유무와 무관하게 총량 동일
    expect(a.report.quotes_total).toBe(b.report.quotes_total);
  });
});
