import { describe, expect, it } from "vitest";
import { aggregate, renderReport, runBatch, type BatchOutcome } from "../eval/batch.js";
import type { AnalysisResult, Brief, DomainTier } from "../src/types.js";

// 최소 브리프 — aggregate 는 tier·verification·skipped_attachments 만 읽으므로 그 부분만 채운다.
function published(tier: DomainTier, passed: number, total: number, skipped: { kind: string; fileName: string | null }[] = []): AnalysisResult {
  return {
    ok: true,
    brief: {
      tier,
      verification: { quotes_total: total, quotes_passed: passed },
      skipped_attachments: skipped,
    } as unknown as Brief,
  };
}

function held(reason: string, tier: DomainTier = "tier1"): AnalysisResult {
  return { ok: false, stage: "verify", reason, tier, source_url: "u" };
}
function rejected(reason: string, tier: DomainTier = "tier2"): AnalysisResult {
  return { ok: false, stage: "classify", not_a_program: true, reason, tier, source_url: "u" };
}
function collectFailed(reason: string): AnalysisResult {
  return { ok: false, stage: "collect", reason, source_url: "u" };
}

function outcome(result: AnalysisResult, ms: number): BatchOutcome {
  return { url: "u", result, ms };
}

describe("aggregate — 집계", () => {
  it("결과 분포·티어·인용 통과율·HWP·p90 를 집계한다", () => {
    const outcomes: BatchOutcome[] = [
      outcome(published("tier1", 10, 10, [{ kind: "hwp", fileName: "x.hwp" }, { kind: "다운로드 실패", fileName: "y.pdf" }]), 100),
      outcome(published("tier1", 9, 10), 200),
      outcome(published("tier2", 6, 10), 300),
      outcome(published("tier2", 2, 5), 400),
      outcome(held("자격 요건 인용 검증 통과율 미달 (2/5)"), 500),
      outcome(held("자격 요건 인용 검증 통과율 미달 (1/4)"), 600),
      outcome(held("마감일을 원문에서 검증하지 못함"), 700),
      outcome(rejected("선정 결과 발표 페이지"), 800),
      outcome(collectFailed("HTTP 404"), 900),
      outcome(collectFailed("타임아웃"), 1000),
    ];

    const report = aggregate(outcomes);

    expect(report.total).toBe(10);
    expect(report.published).toBe(4);
    expect(report.held).toBe(3);
    expect(report.rejected).toBe(1);
    expect(report.collectFailed).toBe(2);
    expect(report.otherFailed).toBe(0);

    // tier1 = 발행 2 + 보류 3(기본 tier1), tier2 = 발행 2 + 반려 1(기본 tier2), 수집실패 2는 tier 없음
    expect(report.tier).toEqual({ tier1: 5, tier2: 3, tier3: 0 });

    // 인용 통과율: 1.0, 0.9, 0.6, 0.4 → 평균 0.725
    expect(report.citation.withQuotes).toBe(4);
    expect(report.citation.avgPassRate).toBeCloseTo(0.725, 3);
    expect(report.citation.buckets).toMatchObject({ "100%": 1, "80-99%": 1, "50-79%": 1, "<50%": 1 });

    // HWP 스킵
    expect(report.hwp.skippedTotal).toBe(2);
    expect(report.hwp.hwpSkipped).toBe(1);

    // 소요시간: 평균 550, p90 = 9번째(=900)
    expect(report.durationMs.avg).toBeCloseTo(550, 0);
    expect(report.durationMs.p90).toBe(900);

    // 사유 top: 숫자 정규화로 (2/5),(1/4) 가 하나로 묶여 count 2 가 최상위
    expect(report.reasonsTop[0]).toMatchObject({ count: 2 });
    expect(report.reasonsTop[0]?.reason).toMatch(/통과율 미달/);
    expect(report.rejectedReasonsTop[0]?.reason).toMatch(/선정 결과/);
  });

  it("빈 입력이면 통과율 null, 0 건", () => {
    const report = aggregate([]);
    expect(report.total).toBe(0);
    expect(report.citation.avgPassRate).toBeNull();
    expect(renderReport(report)).toContain("총 0건");
  });
});

describe("runBatch — 동시성 풀 + 집계 (mock analyzeOne)", () => {
  it("URL 별 결과를 모아 집계한다 (DB·발행 없음)", async () => {
    const canned: Record<string, AnalysisResult> = {
      "u-pub-1": published("tier1", 8, 8),
      "u-pub-2": published("tier1", 7, 9),
      "u-rej": rejected("비공고"),
      "u-held": held("마감일 검증 실패"),
      "u-collect": collectFailed("HTTP 500"),
    };
    const urls = Object.keys(canned);
    const progress: string[] = [];

    const { report, outcomes } = await runBatch(urls, {
      concurrency: 2,
      analyzeOne: async (url) => ({ result: canned[url]!, ms: 10 }),
      onProgress: (o) => progress.push(o.url),
    });

    expect(outcomes).toHaveLength(5);
    expect(progress).toHaveLength(5);
    expect(report.published).toBe(2);
    expect(report.rejected).toBe(1);
    expect(report.held).toBe(1);
    expect(report.collectFailed).toBe(1);
    expect(report.citation.avgPassRate).not.toBeNull();
  });
});
