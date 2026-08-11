import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeUrl } from "../src/agent/orchestrator.js";
import { htmlToText } from "../src/collect/html.js";
import { renderMarkdown } from "../src/brief/render.js";
import { matchProfile, profileSchema } from "../src/match/profile.js";
import type { LlmRunner } from "../src/llm/runner.js";
import type { CollectResult } from "../src/collect/index.js";
import type { PrecheckResult } from "../src/collect/precheck.js";

const NOTICE_URL = "https://example.go.kr/notice/241";
const fixtureText = htmlToText(readFileSync(join(__dirname, "../fixtures/sample-notice.html"), "utf8"));

const collectStub = async (): Promise<CollectResult> => {
  const doc = { url: NOTICE_URL, kind: "html" as const, title: "2026년 서울 초기창업 성장지원 사업 참여기업 모집 공고", text: fixtureText };
  return {
    documents: [doc],
    rawDocuments: [doc],
    skipped: [{ url: "https://example.go.kr/files/form_2026_241.hwp", kind: "hwp", fileName: "사업계획서 양식.hwp" }],
    contact: { phones: ["02-123-4567"], emails: [] },
  };
};

// 프리체크를 Solar 판정 경로(needs_llm)로 강제하는 스텁 — classify 를 태우는 테스트용.
const forceNeedsLlm = async (): Promise<PrecheckResult> => ({ verdict: "needs_llm", tier: "tier1" });

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

  it("LLM·문서 유래 HTML과 위험한 Markdown 링크를 게시 전에 무력화한다", async () => {
    const malicious = JSON.parse(extractionJson(false));
    malicious.overview.title = '<img src=x onerror=alert(1)> [click](javascript:alert(1))';
    malicious.requirements[0].text = '<script>alert(1)</script> 신청 조건';
    const advice = JSON.parse(adviceOk);
    advice.why_look = '<svg onload=alert(1)> [보기](javascript:alert(1)) 안전성 확인이 필요한 공고입니다.';

    const result = await analyzeUrl(NOTICE_URL, {
      runner: mockRunner({ extract: () => JSON.stringify(malicious), advise: JSON.stringify(advice) }),
      collectImpl: collectStub,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = JSON.stringify(result.brief);
    expect(rendered).not.toContain("<script");
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("<svg");
    expect(rendered.toLowerCase()).not.toContain("javascript:");
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

  it("공고가 아니면 반려 (프리체크 애매 → Solar 판정)", async () => {
    const runner = mockRunner({
      classify: JSON.stringify({ is_program: false, reason: "선정 결과 발표 페이지", title: null, organizer: null }),
    });
    const result = await analyzeUrl(NOTICE_URL, { runner, collectImpl: collectStub, precheckImpl: forceNeedsLlm });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.not_a_program).toBe(true);
    expect(runner.calls).toContain("classify");
  });
});

describe("프리체크 통합 (오케스트레이터)", () => {
  it("pass_fast: 공공 도메인 + 공고 패턴 → Solar 판정(classify) 생략 후 발행", async () => {
    const runner = mockRunner();
    const result = await analyzeUrl(NOTICE_URL, { runner, collectImpl: collectStub });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.tier).toBe("tier1");
    expect(runner.calls).not.toContain("classify"); // pass_fast 이므로 판정 스텝 생략
    expect(runner.calls.some((call) => call.startsWith("extract"))).toBe(true);
  });

  it("reject: 프리체크 반려 → not_a_program (추출 없이 즉시 종료)", async () => {
    const runner = mockRunner();
    const reject = async (): Promise<PrecheckResult> => ({ verdict: "reject", tier: "tier3", reason: "IP 리터럴 호스트" });
    const stages: unknown[] = [];
    const result = await analyzeUrl(NOTICE_URL, {
      runner,
      collectImpl: collectStub,
      precheckImpl: reject,
      onStageA: (info) => void stages.push(info),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.not_a_program).toBe(true);
    expect(result.tier).toBe("tier3");
    expect(runner.calls).toHaveLength(0); // LLM 호출 없음
    expect(stages).toEqual([{ is_program: false, tier: "tier3", reason: "IP 리터럴 호스트" }]);
  });

  it("onStageA: needs_llm 판정 후 is_program 을 보고한다", async () => {
    const runner = mockRunner();
    const stages: { is_program: boolean; tier: string }[] = [];
    const result = await analyzeUrl(NOTICE_URL, {
      runner,
      collectImpl: collectStub,
      precheckImpl: forceNeedsLlm,
      onStageA: (info) => void stages.push(info),
    });
    expect(result.ok).toBe(true);
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ is_program: true, tier: "tier1" });
  });
});

describe("장문 문서 강등 재시도", () => {
  it("추출이 타임아웃으로 죽으면 입력을 축소해 한 번 더 시도한다", async () => {
    const runner = mockRunner({
      extract: (round) => {
        if (round === 0) throw new Error("Solar API 실패 (3회 시도): network: The operation was aborted due to timeout");
        return extractionJson(false);
      },
    });
    const result = await analyzeUrl(NOTICE_URL, { runner, collectImpl: collectStub });
    expect(result.ok).toBe(true);
    expect(runner.calls.filter((call) => call.startsWith("extract"))).toHaveLength(2);
  });

  it("축소 재시도까지 실패하면 두 사유를 합쳐 보고한다", async () => {
    const runner = mockRunner({
      extract: () => {
        throw new Error("Solar API 실패 (3회 시도): truncated content (finish_reason=length)");
      },
    });
    const result = await analyzeUrl(NOTICE_URL, { runner, collectImpl: collectStub });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("extract");
    expect(result.reason).toContain("입력 축소 재시도도 실패");
  });
});

describe("진행 보고 — 러너가 흘리는 실제 상태가 화면까지 간다", () => {
  /** 러너가 호출 중 상태를 보고하는 상황을 흉내낸다 (Solar 의 응답 대기·재시도 보고). */
  function reportingRunner(): LlmRunner {
    let extractRound = -1;
    return {
      name: "mock-solar",
      async complete({ system, onActivity }): Promise<string> {
        if (system?.includes("감별")) return classifyOk;
        if (system?.includes("구조화")) {
          extractRound++;
          onActivity?.("mock-solar 응답 대기 — 원문 1,234자 전송");
          onActivity?.("응답 수신 900자 — 구조 파싱");
          return extractionJson(false);
        }
        return adviceOk;
      },
    };
  }

  it("추출 중 보고가 extract 단계의 detail 로 전달된다", async () => {
    const seen: { step: string; detail?: string }[] = [];
    await analyzeUrl(NOTICE_URL, {
      runner: reportingRunner(),
      collectImpl: collectStub,
      onStep: (step, detail) => seen.push({ step, detail }),
    });
    const extractDetails = seen.filter((s) => s.step === "extract").map((s) => s.detail);
    expect(extractDetails).toContain("mock-solar 응답 대기 — 원문 1,234자 전송");
    expect(extractDetails).toContain("응답 수신 900자 — 구조 파싱");
  });

  it("보고를 안 하는 러너여도 파이프라인은 그대로 돈다", async () => {
    const result = await analyzeUrl(NOTICE_URL, { runner: mockRunner(), collectImpl: collectStub });
    expect(result.ok).toBe(true);
  });
});

// 2회 교차 검증 (한영 결정 2026-08-11) — 크레딧을 품질로 바꾸는 경로.
// 불일치는 "틀림"이 아니라 "모름"으로 내린다: 값을 비우고 브리프는 계속 발행한다.
describe("교차 검증 통합 (오케스트레이터)", () => {
  it("2회 일치하면 그대로 발행하고 cross_check 를 남긴다", async () => {
    const runner = mockRunner();
    const result = await analyzeUrl(NOTICE_URL, { runner, collectImpl: collectStub, crossCheckRuns: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(runner.calls.filter((call) => call.startsWith("extract"))).toHaveLength(2);
    const cross = result.brief.verification.cross_check;
    expect(cross?.runs).toBe(2);
    expect(cross?.fields_agreed).toBe(cross?.fields_checked);
    expect(cross?.dropped).toEqual([]);
    expect(result.brief.overview.amount_max_krw).toBe(50_000_000);
  });

  it("2차가 다른 값을 내면 그 값만 비우고 나머지는 발행한다", async () => {
    const disagreeing = JSON.parse(extractionJson(false));
    disagreeing.overview.amount_max_krw = 30_000_000;
    const runner = mockRunner({
      extract: (round) => (round === 1 ? JSON.stringify(disagreeing) : extractionJson(false)),
    });
    const result = await analyzeUrl(NOTICE_URL, { runner, collectImpl: collectStub, crossCheckRuns: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.overview.amount_max_krw).toBeNull();
    expect(result.brief.verification.cross_check?.dropped).toContain("overview.amount_max_krw");
    // 일치한 값·항목은 살아 있다
    expect(result.brief.overview.apply_end).toBe("2026-08-14");
    expect(result.brief.requirements).toHaveLength(2);
  });

  it("2차 추출이 실패하면 1회 결과로 발행하고 cross_check 를 붙이지 않는다", async () => {
    const runner = mockRunner({
      extract: (round) => {
        if (round === 1) throw new Error("2차 호출 타임아웃");
        return extractionJson(false);
      },
    });
    const result = await analyzeUrl(NOTICE_URL, { runner, collectImpl: collectStub, crossCheckRuns: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 없음 = "교차 검증 안 함". "일치했음"으로 읽히면 안 된다.
    expect(result.brief.verification.cross_check).toBeUndefined();
    expect(result.brief.overview.amount_max_krw).toBe(50_000_000);
  });

  it("기본값(미지정)은 1회 — 켠 적 없는 동작을 바꾸지 않는다", async () => {
    const runner = mockRunner();
    const result = await analyzeUrl(NOTICE_URL, { runner, collectImpl: collectStub });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(runner.calls.filter((call) => call.startsWith("extract"))).toHaveLength(1);
    expect(result.brief.verification.cross_check).toBeUndefined();
  });
});
