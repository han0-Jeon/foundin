import { describe, expect, it } from "vitest";
import { buildInquiryQuestions } from "../src/brief/inquiry.js";
import type { Brief } from "../src/types.js";

type BriefInput = Omit<Brief, "inquiry_questions">;

function baseBrief(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    source_url: "https://www.k-startup.go.kr/notice/1",
    analyzed_at: "2026-07-19T10:00:00.000Z",
    model: "solar-open2",
    tier: "tier1",
    overview: {
      title: "테스트 지원사업",
      organizer: "창업진흥원",
      apply_start: "2026-07-01",
      apply_end: "2026-07-31",
      apply_end_time: "16:00",
      amount_max_krw: 50_000_000,
      amount_note: null,
      support_scale: "10개사",
      self_funding_note: null,
    },
    eligibility: {
      allows_pre_startup: true,
      excludes_pre_startup: null,
      requires_business_registration: null,
      min_startup_years: null,
      max_startup_years: 7,
      min_age: null,
      max_age: null,
      max_revenue_krw: null,
      max_employees: null,
      target_regions: [],
      required_certifications: [],
      excluded_targets: [],
    },
    why_look: null,
    requirements: [],
    exclusions: [],
    documents: [],
    schedule: [],
    risk_points: [],
    verification: {
      quotes_total: 5,
      quotes_passed: 5,
      held: [],
      value_issues: [],
      conflicts: [],
      publishable: true,
      gate_reason: null,
    },
    documents_meta: [],
    skipped_attachments: [],
    contact: null,
    confidence: 0.9,
    ...overrides,
  };
}

const evidence = { quote: "인용", source_url: "https://www.k-startup.go.kr/notice/1" };

describe("기관 문의 질문 생성 (결정적, Solar 미호출)", () => {
  it("전부 검증 통과 + 값 완비면 질문 없음", () => {
    expect(buildInquiryQuestions(baseBrief())).toEqual([]);
  });

  it("마감일 없음 → 마감 확인 질문", () => {
    const brief = baseBrief();
    brief.overview = { ...brief.overview, apply_end: null };
    const questions = buildInquiryQuestions(brief);
    expect(questions[0]!.topic).toBe("접수 마감");
    expect(questions[0]!.question).toContain("마감");
  });

  it("마감일 보류(원문 대조 실패) → 추출값을 포함한 재확인 질문", () => {
    const brief = baseBrief();
    brief.verification = { ...brief.verification, held: ["overview.apply_end"] };
    const questions = buildInquiryQuestions(brief);
    expect(questions[0]!.topic).toBe("접수 마감");
    expect(questions[0]!.question).toContain("2026-07-31");
  });

  it("보류된 자격 요건 → 요건 텍스트 인용 질문 (최대 3건)", () => {
    const brief = baseBrief({
      requirements: [
        { verified: true, item: { text: "통과 요건", evidence, branch_advice: null } },
        { verified: false, item: { text: "대표자 만 39세 이하", evidence, branch_advice: null } },
        { verified: false, item: { text: "요건 B", evidence, branch_advice: null } },
        { verified: false, item: { text: "요건 C", evidence, branch_advice: null } },
        { verified: false, item: { text: "요건 D — 4번째라 잘림", evidence, branch_advice: null } },
      ],
    });
    const questions = buildInquiryQuestions(brief);
    const reqQuestions = questions.filter((q) => q.topic === "자격 요건");
    expect(reqQuestions).toHaveLength(3);
    expect(reqQuestions[0]!.question).toContain("만 39세 이하");
  });

  it("문서 간 충돌 + 읽지 못한 첨부 → 각각 질문 생성", () => {
    const brief = baseBrief({
      skipped_attachments: [{ url: "https://x.go.kr/f.hwp", kind: "암호화 문서", fileName: "신청서.hwp" }],
    });
    brief.verification = { ...brief.verification, conflicts: ["apply_end: 본문 2026-07-31 vs 첨부 2026-08-05"] };
    const questions = buildInquiryQuestions(brief);
    expect(questions.some((q) => q.topic === "문서 간 충돌" && q.question.includes("08-05"))).toBe(true);
    expect(questions.some((q) => q.topic === "미확인 첨부" && q.question.includes("신청서.hwp"))).toBe(true);
  });

  it("질문 총량은 8건 이하", () => {
    const manyReqs = Array.from({ length: 12 }, (_, i) => ({
      verified: false,
      item: { text: `요건 ${i}`, evidence, branch_advice: null },
    }));
    const manyDocs = Array.from({ length: 5 }, (_, i) => ({
      verified: false,
      item: { name: `서류 ${i}`, note: null, evidence },
    }));
    const brief = baseBrief({
      requirements: manyReqs,
      documents: manyDocs,
      skipped_attachments: [
        { url: "https://x.go.kr/a.hwp", kind: "암호화", fileName: "a.hwp" },
        { url: "https://x.go.kr/b.hwp", kind: "암호화", fileName: "b.hwp" },
        { url: "https://x.go.kr/c.hwp", kind: "암호화", fileName: "c.hwp" },
      ],
    });
    brief.overview = { ...brief.overview, apply_end: null, amount_max_krw: null, support_scale: null };
    brief.verification = { ...brief.verification, conflicts: ["충돌 1", "충돌 2", "충돌 3"] };
    expect(buildInquiryQuestions(brief).length).toBeLessThanOrEqual(8);
  });
});
