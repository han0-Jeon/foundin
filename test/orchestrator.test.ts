import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeUrl } from "../src/agent/orchestrator.js";
import { htmlToText } from "../src/collect/html.js";
import { renderMarkdown } from "../src/brief/render.js";
import { matchProfile, profileSchema } from "../src/match/profile.js";
import type { LlmRunner } from "../src/llm/runner.js";
import type { CollectResult } from "../src/collect/index.js";

const NOTICE_URL = "https://example.go.kr/notice/241";
const fixtureText = htmlToText(readFileSync(join(__dirname, "../fixtures/sample-notice.html"), "utf8"));

const collectStub = async (): Promise<CollectResult> => ({
  documents: [{ url: NOTICE_URL, kind: "html", title: "2026년 서울 초기창업 성장지원 사업 참여기업 모집 공고", text: fixtureText }],
  skipped: [{ url: "https://example.go.kr/files/form_2026_241.hwp", kind: "hwp", fileName: "사업계획서 양식.hwp" }],
  contact: { phones: ["02-123-4567"], emails: [], lines: ["문의: 창업지원팀 02-123-4567"] },
});

const classifyOk = JSON.stringify({
  is_program: true,
  reason: "지원금·신청 자격·접수 기간이 명시된 모집 공고",
  title: "2026년 서울 초기창업 성장지원 사업",
  organizer: "예시경제진흥원",
});

function extractionJson(withHallucination: boolean): string {
  return JSON.stringify({
    overview: {
      title: "2026년 서울 초기창업 성장지원 사업",
      organizer: "예시경제진흥원",
      apply_start: "2026-07-21",
      apply_end: "2026-08-14",
      apply_end_time: "16:00",
      amount_max_krw: 50_000_000,
      amount_note: "총 사업비의 70% 이내",
      support_scale: "40개사 내외",
      self_funding_note: "총 사업비의 30% 이상 (현금 10% 이상 포함)",
    },
    overview_evidence: [
      { field: "apply_start", quote: "접수기간: 2026. 7. 21.(화) ~ 2026. 8. 14.(금) 16:00", source_url: NOTICE_URL },
      { field: "apply_end", quote: "접수기간: 2026. 7. 21.(화) ~ 2026. 8. 14.(금) 16:00", source_url: NOTICE_URL },
      { field: "amount_max_krw", quote: "사업화 자금 기업당 최대 5,000만원", source_url: NOTICE_URL },
      { field: "support_scale", quote: "지원규모: 40개사 내외", source_url: NOTICE_URL },
    ],
    eligibility: {
      allows_pre_startup: false,
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
    requirements: [
      {
        text: "공고일 기준 사업자등록 완료, 창업 7년 이내",
        evidence: { quote: "공고일 기준 사업자등록을 완료한 창업 7년 이내 기업", source_url: NOTICE_URL },
        branch_advice: null,
      },
      {
        text: "본점 또는 주사업장 서울 소재",
        evidence: {
          quote: withHallucination
            ? "대표자가 만 39세 이하인 청년 기업만 신청할 수 있다"
            : "신청일 기준 본점 또는 주사업장이 서울특별시에 소재한 기업",
          source_url: NOTICE_URL,
        },
        branch_advice: null,
      },
    ],
    exclusions: [
      { text: "국세·지방세 체납 기업", evidence: { quote: "국세 및 지방세를 체납 중인 기업", source_url: NOTICE_URL } },
    ],
    documents: [
      {
        name: "사업계획서 (지정 양식)",
        note: "자유 양식 제출 시 접수 무효",
        evidence: { quote: "사업계획서 1부 (지정 양식, 자유 양식 제출 시 접수 무효)", source_url: NOTICE_URL },
      },
    ],
    schedule: [
      { label: "접수", date_text: "2026.7.21 ~ 8.14 16:00", evidence: { quote: "접수기간: 2026. 7. 21.(화) ~ 2026. 8. 14.(금) 16:00", source_url: NOTICE_URL } },
    ],
    risk_points: [
      { text: "자유 양식 사업계획서는 접수 무효", evidence: { quote: "자유 양식 제출 시 접수 무효", source_url: NOTICE_URL } },
      { text: "마감 시각(16:00) 이후 접수 불가", evidence: { quote: "마감 시각 이후 접수 불가", source_url: NOTICE_URL } },
    ],
    confidence: 0.9,
    notes: null,
  });
}

const adviceOk = JSON.stringify({
  why_look: "서울 소재 7년 이내 기업이 최대 5,000만원의 사업화 자금을 받을 수 있는 공고다. 지원 규모가 40개사로 크지 않아 경쟁이 예상된다. 자부담 30% 요건이 있어 자금 계획 확인이 필요하다.",
  requirement_advice: [
    {
      index: 0,
      branch_advice: {
        pre_startup: "예비창업자는 접수 마감 전 사업자등록을 완료해야 신청 가능하다.",
        registered: "사업자등록일 기준 7년 이내인지 확인하라.",
      },
    },
  ],
});

function mockRunner(overrides?: { classify?: string; extract?: (round: number) => string; advise?: string }): LlmRunner & { calls: string[] } {
  let extractRound = -1;
  const runner = {
    name: "mock-solar",
    calls: [] as string[],
    async complete({ system }: { system?: string }): Promise<string> {
      if (system?.includes("감별")) {
        runner.calls.push("classify");
        return overrides?.classify ?? classifyOk;
      }
      if (system?.includes("구조화")) {
        extractRound++;
        runner.calls.push(`extract${extractRound}`);
        return overrides?.extract ? overrides.extract(extractRound) : extractionJson(false);
      }
      runner.calls.push("advise");
      return overrides?.advise ?? adviceOk;
    },
  };
  return runner;
}

describe("오케스트레이터 엔드투엔드 (mock)", () => {
  it("정상 공고 → 검증 통과 브리프 발행", async () => {
    const runner = mockRunner();
    const result = await analyzeUrl(NOTICE_URL, { runner, collectImpl: collectStub });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.brief.verification.publishable).toBe(true);
    expect(result.brief.requirements).toHaveLength(2);
    expect(result.brief.requirements.every((requirement) => requirement.verified)).toBe(true);
    expect(result.brief.requirements[0]?.item.branch_advice?.pre_startup).toContain("사업자등록");
    expect(result.brief.why_look).toContain("5,000만원");
    expect(result.brief.skipped_attachments[0]?.kind).toBe("hwp");

    const markdown = renderMarkdown(result.brief, {
      profile: profileSchema.parse({ biz_stage: "pre", regions: ["서울"], age: 34, has_biz_reg: false }),
      result: matchProfile(result.brief, profileSchema.parse({ biz_stage: "pre", regions: ["서울"], age: 34, has_biz_reg: false })),
    });
    expect(markdown).toContain("참고용");
    expect(markdown).toContain("자동 분석하지 못한 첨부");
    expect(markdown).toContain("지원 불가"); // 예비창업 + 사업자등록 필수
  });

  it("환각 인용 지속 → 재추출 후에도 실패면 미발행 (fail-closed)", async () => {
    const runner = mockRunner({ extract: () => extractionJson(true) });
    const result = await analyzeUrl(NOTICE_URL, { runner, collectImpl: collectStub });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("verify");
    expect(runner.calls.filter((call) => call.startsWith("extract"))).toHaveLength(2); // 재추출 1회 수행
  });

  it("환각 인용 → 재추출로 교정되면 발행", async () => {
    const runner = mockRunner({ extract: (round) => extractionJson(round === 0) });
    const result = await analyzeUrl(NOTICE_URL, { runner, collectImpl: collectStub });
    expect(result.ok).toBe(true);
  });

  it("공고가 아니면 반려", async () => {
    const runner = mockRunner({
      classify: JSON.stringify({ is_program: false, reason: "선정 결과 발표 페이지", title: null, organizer: null }),
    });
    const result = await analyzeUrl(NOTICE_URL, { runner, collectImpl: collectStub });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.not_a_program).toBe(true);
  });
});
