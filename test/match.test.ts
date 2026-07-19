import { describe, expect, it } from "vitest";
import { matchProfile, profileSchema } from "../src/match/profile.js";
import type { Brief } from "../src/types.js";

function makeBrief(overrides: Partial<Brief["eligibility"]>, applyEnd: string | null = "2099-12-31"): Brief {
  return {
    source_url: "https://example.go.kr/notice",
    analyzed_at: new Date().toISOString(),
    model: "test",
    overview: {
      title: "테스트 공고",
      organizer: null,
      apply_start: null,
      apply_end: applyEnd,
      apply_end_time: null,
      amount_max_krw: null,
      amount_note: null,
      support_scale: null,
      self_funding_note: null,
    },
    eligibility: {
      allows_pre_startup: null,
      excludes_pre_startup: null,
      requires_business_registration: null,
      min_startup_years: null,
      max_startup_years: null,
      min_age: null,
      max_age: null,
      max_revenue_krw: null,
      max_employees: null,
      target_regions: [],
      required_certifications: [],
      excluded_targets: [],
      ...overrides,
    },
    why_look: null,
    requirements: [],
    exclusions: [],
    documents: [],
    schedule: [],
    risk_points: [],
    verification: { quotes_total: 0, quotes_passed: 0, held: [], value_issues: [], conflicts: [], publishable: true, gate_reason: null },
    documents_meta: [],
    skipped_attachments: [],
    confidence: 1,
  };
}

const preSeoul = profileSchema.parse({ biz_stage: "pre", regions: ["서울"], age: 34, has_biz_reg: false });

describe("로컬 프로필 매칭", () => {
  it("예비창업자 + 사업자등록 필수 → 지원 불가 (biz_reg)", () => {
    const result = matchProfile(makeBrief({ requires_business_registration: true }), preSeoul);
    expect(result.status).toBe("ineligible");
    expect(result.checks.find((check) => check.key === "biz_reg")?.status).toBe("no");
    expect(result.segment).toBe("pre_startup");
  });

  it("예비창업 허용 + 서울 + 연령 충족 → 지원 가능", () => {
    const result = matchProfile(
      makeBrief({ allows_pre_startup: true, target_regions: ["서울"], min_age: null, max_age: 39 }),
      preSeoul,
    );
    expect(result.status).toBe("eligible");
    expect(result.checks.find((check) => check.key === "region")?.status).toBe("ok");
    expect(result.checks.find((check) => check.key === "age")?.status).toBe("ok");
  });

  it("명시 없는 공고 → 확인 필요", () => {
    const result = matchProfile(makeBrief({}), preSeoul);
    expect(result.status).toBe("needs_review");
  });

  it("마감 지난 공고 → 지원 불가", () => {
    const result = matchProfile(makeBrief({ allows_pre_startup: true }, "2020-01-01"), preSeoul);
    expect(result.status).toBe("ineligible");
    expect(result.checks.find((check) => check.key === "deadline")?.status).toBe("no");
  });

  it("지역 불일치 → 지원 불가", () => {
    const busan = profileSchema.parse({ biz_stage: "pre", regions: ["부산"], age: 34, has_biz_reg: false });
    const result = matchProfile(makeBrief({ allows_pre_startup: true, target_regions: ["서울"] }), busan);
    expect(result.status).toBe("ineligible");
  });
});
