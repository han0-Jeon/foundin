// 평가 하니스 — URL 목록을 배치로 분석해 파이프라인 지표를 집계한다.
//   npm run eval -- --urls eval-urls.txt [--concurrency 3] [--runner solar|claude-code|codex] [--no-cache]
//
// 발행/반려/보류/수집실패 건수, 인용 검증 통과율, 보류·실패 사유 top5, HWP 스킵, 소요시간(평균·p90)을
// 낸다. **DB 기록·발행은 하지 않는다** (백필 아님, 지표 전용). 캐시는 활용한다.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeUrl } from "../src/agent/orchestrator.js";
import { readCache, writeCache } from "../src/cache.js";
import { loadDotEnv } from "../src/env.js";
import { createRunner } from "../src/llm/runner.js";
import type { AnalysisResult, DomainTier } from "../src/types.js";

export interface BatchOutcome {
  url: string;
  result: AnalysisResult;
  ms: number;
  cached?: boolean;
}

export interface ReasonCount {
  reason: string;
  count: number;
}

export interface BatchReport {
  total: number;
  published: number;
  rejected: number; // 비공고(프리체크/Solar 판정)
  held: number; // 검증 게이트 미통과
  collectFailed: number; // 수집 실패
  otherFailed: number; // 판정·추출 등 기타 실패
  tier: Record<DomainTier, number>;
  citation: {
    /** 발행 브리프의 quotes_passed/quotes_total 평균 (인용 있는 것만). 없으면 null */
    avgPassRate: number | null;
    withQuotes: number;
    buckets: Record<string, number>;
  };
  hwp: { skippedTotal: number; hwpSkipped: number };
  durationMs: { avg: number; p90: number };
  /** 보류·실패 사유 top5 (숫자는 N 으로 정규화해 유사 사유를 묶는다) */
  reasonsTop: ReasonCount[];
  /** 비공고 반려 사유 top5 */
  rejectedReasonsTop: ReasonCount[];
}

const CITATION_BUCKETS = ["100%", "80-99%", "50-79%", "<50%"] as const;

function bucketFor(rate: number): (typeof CITATION_BUCKETS)[number] {
  if (rate >= 1) return "100%";
  if (rate >= 0.8) return "80-99%";
  if (rate >= 0.5) return "50-79%";
  return "<50%";
}

function normalizeReason(reason: string): string {
  return reason.replace(/\d+/g, "N").trim().slice(0, 90);
}

function topReasons(reasons: string[], limit = 5): ReasonCount[] {
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    const key = normalizeReason(reason);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

export function aggregate(outcomes: BatchOutcome[]): BatchReport {
  const tier: Record<DomainTier, number> = { tier1: 0, tier2: 0, tier3: 0 };
  const citationRates: number[] = [];
  const buckets: Record<string, number> = Object.fromEntries(CITATION_BUCKETS.map((b) => [b, 0]));
  const durations: number[] = [];
  const failReasons: string[] = [];
  const rejectedReasons: string[] = [];
  let published = 0;
  let rejected = 0;
  let held = 0;
  let collectFailed = 0;
  let otherFailed = 0;
  let skippedTotal = 0;
  let hwpSkipped = 0;

  for (const { result, ms } of outcomes) {
    durations.push(ms);
    const outcomeTier = result.ok ? result.brief.tier : result.tier;
    if (outcomeTier) tier[outcomeTier]++;

    if (result.ok) {
      published++;
      const brief = result.brief;
      const { quotes_total: total, quotes_passed: passed } = brief.verification;
      if (total > 0) {
        const rate = passed / total;
        citationRates.push(rate);
        buckets[bucketFor(rate)] = (buckets[bucketFor(rate)] ?? 0) + 1;
      }
      for (const skip of brief.skipped_attachments) {
        skippedTotal++;
        if (/hwp/i.test(skip.kind) || /\.hwpx?$/i.test(skip.fileName ?? "")) hwpSkipped++;
      }
    } else if (result.not_a_program) {
      rejected++;
      rejectedReasons.push(result.reason);
    } else if (result.stage === "verify") {
      held++;
      failReasons.push(result.reason);
    } else if (result.stage === "collect") {
      collectFailed++;
      failReasons.push(result.reason);
    } else {
      otherFailed++;
      failReasons.push(result.reason);
    }
  }

  const avgPassRate =
    citationRates.length > 0 ? citationRates.reduce((sum, r) => sum + r, 0) / citationRates.length : null;
  const avgMs = durations.length > 0 ? durations.reduce((sum, d) => sum + d, 0) / durations.length : 0;

  return {
    total: outcomes.length,
    published,
    rejected,
    held,
    collectFailed,
    otherFailed,
    tier,
    citation: { avgPassRate, withQuotes: citationRates.length, buckets },
    hwp: { skippedTotal, hwpSkipped },
    durationMs: { avg: avgMs, p90: percentile(durations, 0.9) },
    reasonsTop: topReasons(failReasons),
    rejectedReasonsTop: topReasons(rejectedReasons),
  };
}

function pct(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderReport(report: BatchReport, meta: { runner: string; urlsFile: string } = { runner: "?", urlsFile: "?" }): string {
  const r = report;
  const lines: string[] = [
    `# foundin 배치 평가 리포트`,
    ``,
    `실행: ${new Date().toISOString()} · 러너: ${meta.runner} · 입력: ${meta.urlsFile}`,
    ``,
    `## 결과 분포 (총 ${r.total}건)`,
    ``,
    `| 결과 | 건수 |`,
    `| --- | ---: |`,
    `| 발행(published) | ${r.published} |`,
    `| 반려·비공고(rejected) | ${r.rejected} |`,
    `| 보류·게이트(held) | ${r.held} |`,
    `| 수집 실패(collect) | ${r.collectFailed} |`,
    `| 기타 실패(classify/extract) | ${r.otherFailed} |`,
    ``,
    `## 출처 티어`,
    ``,
    `- Tier1(공공): ${r.tier.tier1} · Tier2(일반): ${r.tier.tier2} · Tier3(반려): ${r.tier.tier3}`,
    ``,
    `## 인용 검증 통과율 (발행 브리프)`,
    ``,
    `- 평균: ${pct(r.citation.avgPassRate)} (인용 있는 브리프 ${r.citation.withQuotes}건)`,
    `- 분포: ${CITATION_BUCKETS.map((b) => `${b} ${r.citation.buckets[b] ?? 0}건`).join(" · ")}`,
    ``,
    `## HWP 스킵`,
    ``,
    `- 미분석 첨부 ${r.hwp.skippedTotal}건 중 HWP/HWPX ${r.hwp.hwpSkipped}건`,
    ``,
    `## 소요시간`,
    ``,
    `- 평균 ${secs(r.durationMs.avg)} · p90 ${secs(r.durationMs.p90)}`,
    ``,
    `## 보류·실패 사유 top5`,
    ``,
    ...(r.reasonsTop.length > 0 ? r.reasonsTop.map((x) => `- (${x.count}) ${x.reason}`) : ["- (없음)"]),
    ``,
    `## 비공고 반려 사유 top5`,
    ``,
    ...(r.rejectedReasonsTop.length > 0 ? r.rejectedReasonsTop.map((x) => `- (${x.count}) ${x.reason}`) : ["- (없음)"]),
    ``,
    `> 지표 전용 리포트입니다. 이 실행은 DB 기록·발행을 하지 않습니다.`,
    ``,
  ];
  return lines.join("\n");
}

export interface RunBatchDeps {
  analyzeOne: (url: string, index: number) => Promise<{ result: AnalysisResult; ms: number; cached?: boolean }>;
  concurrency?: number;
  onProgress?: (outcome: BatchOutcome, done: number, total: number) => void;
}

export async function runBatch(urls: string[], deps: RunBatchDeps): Promise<{ report: BatchReport; outcomes: BatchOutcome[] }> {
  const concurrency = Math.max(1, deps.concurrency ?? 3);
  const outcomes: BatchOutcome[] = [];
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= urls.length) break;
      const url = urls[index]!;
      const { result, ms, cached } = await deps.analyzeOne(url, index);
      const outcome: BatchOutcome = { url, result, ms, cached };
      outcomes.push(outcome);
      done++;
      deps.onProgress?.(outcome, done, urls.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return { report: aggregate(outcomes), outcomes };
}

// ── CLI ──────────────────────────────────────────────────────
function parseFlags(argv: string[]): { urls?: string; concurrency: number; runner?: string; noCache: boolean; out: string } {
  const flags = { urls: undefined as string | undefined, concurrency: 3, runner: undefined as string | undefined, noCache: false, out: "eval/batch-report.md" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--urls") flags.urls = argv[++i];
    else if (arg === "--concurrency") flags.concurrency = Math.max(1, Number(argv[++i] ?? 3));
    else if (arg === "--runner") flags.runner = argv[++i];
    else if (arg === "--no-cache") flags.noCache = true;
    else if (arg === "--out") flags.out = argv[++i] ?? flags.out;
  }
  return flags;
}

async function main(): Promise<number> {
  loadDotEnv();
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.urls) {
    console.error("사용법: npm run eval -- --urls eval-urls.txt [--concurrency 3] [--runner solar] [--no-cache]");
    return 1;
  }
  const urls = (await readFile(flags.urls, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (urls.length === 0) {
    console.error(`${flags.urls} 에 URL 이 없습니다 (한 줄에 하나, # 주석).`);
    return 1;
  }

  const runner = await createRunner(flags.runner);
  console.error(`배치 평가 시작 — ${urls.length}건 · 러너 ${runner.name} · 동시성 ${flags.concurrency}${flags.noCache ? " · 캐시 미사용" : ""}`);

  const analyzeOne = async (url: string): Promise<{ result: AnalysisResult; ms: number; cached?: boolean }> => {
    if (!flags.noCache) {
      const cached = await readCache(url, runner.name);
      if (cached) return { result: cached, ms: 0, cached: true };
    }
    const started = Date.now();
    const result = await analyzeUrl(url, { runner });
    const ms = Date.now() - started;
    await writeCache(url, runner.name, result);
    return { result, ms };
  };

  const { report } = await runBatch(urls, {
    analyzeOne,
    concurrency: flags.concurrency,
    onProgress: ({ url, result, cached }, done, total) => {
      const label = result.ok ? "발행" : result.not_a_program ? "반려" : result.stage === "verify" ? "보류" : "실패";
      console.error(`[${done}/${total}] ${label}${cached ? "(캐시)" : ""} — ${url}`);
    },
  });

  const markdown = renderReport(report, { runner: runner.name, urlsFile: flags.urls });
  await writeFile(join(process.cwd(), flags.out), markdown, "utf8");

  console.log("");
  console.log(`발행 ${report.published} · 반려 ${report.rejected} · 보류 ${report.held} · 수집실패 ${report.collectFailed} · 기타실패 ${report.otherFailed} (총 ${report.total})`);
  console.log(`인용 통과율 평균 ${pct(report.citation.avgPassRate)} · Tier1/2/3 ${report.tier.tier1}/${report.tier.tier2}/${report.tier.tier3}`);
  console.log(`소요 평균 ${secs(report.durationMs.avg)} · p90 ${secs(report.durationMs.p90)} · HWP 스킵 ${report.hwp.hwpSkipped}/${report.hwp.skippedTotal}`);
  console.log(`리포트 저장: ${flags.out}`);
  return 0;
}

const invokedDirectly = process.argv[1] ? /batch\.(ts|js)$/.test(process.argv[1].replace(/\\/g, "/")) : false;
if (invokedDirectly) process.exit(await main());
