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
