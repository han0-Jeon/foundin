#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeUrl } from "./agent/orchestrator.js";
import { renderMarkdown, renderTerminal } from "./brief/render.js";
import { readCache, writeCache } from "./cache.js";
import { loadDotEnv } from "./env.js";
import { createRunner } from "./llm/runner.js";
import { matchProfile, profileSchema, type Profile } from "./match/profile.js";
import { createProgress } from "./ui/progress.js";
import type { AnalysisResult, Brief } from "./types.js";

loadDotEnv();

interface Flags {
  positional: string[];
  json: boolean;
  noCache: boolean;
  noProgress: boolean;
  runner?: string;
  profile?: string;
  urls?: string;
  top: number;
  out: string;
}

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = { positional: [], json: false, noCache: false, noProgress: false, top: 5, out: "out" };
  const command = argv[0] ?? "help";
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") flags.json = true;
    else if (arg === "--no-cache") flags.noCache = true;
    else if (arg === "--no-progress") flags.noProgress = true;
    else if (arg === "--runner") flags.runner = argv[++i];
    else if (arg === "--profile") flags.profile = argv[++i];
    else if (arg === "--urls") flags.urls = argv[++i];
    else if (arg === "--top") flags.top = Number(argv[++i] ?? 5);
    else if (arg === "--out") flags.out = argv[++i] ?? "out";
    else flags.positional.push(arg);
  }
  return { command, flags };
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function loadProfile(path: string): Promise<Profile> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return profileSchema.parse(raw);
}

async function runAnalysis(url: string, flags: Flags): Promise<AnalysisResult> {
  const runner = await createRunner(flags.runner);
  if (!flags.noCache) {
    const cached = await readCache(url, runner.name);
    if (cached) {
      log(`  (캐시 재사용: ${runner.name})`);
      return cached;
    }
  }
  const progress = createProgress({ plain: flags.noProgress });
  let result: AnalysisResult;
  try {
    result = await analyzeUrl(url, { runner, onStep: (step, detail) => progress.step(step, detail) });
  } catch (err) {
    progress.fail();
    throw err;
  }
  if (result.ok) progress.done();
  else progress.fail();
  await writeCache(url, runner.name, result);
  return result;
}

async function saveBrief(brief: Brief, outDir: string, markdown: string): Promise<string> {
  const hash = createHash("sha1").update(brief.source_url).digest("hex").slice(0, 10);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${hash}.json`), JSON.stringify(brief, null, 2), "utf8");
  await writeFile(join(outDir, `${hash}.md`), markdown, "utf8");
  return join(outDir, `${hash}.md`);
}

function describeFailure(result: Extract<AnalysisResult, { ok: false }>): string {
  if (result.not_a_program) return `지원사업 공고가 아닌 것으로 판정: ${result.reason}`;
  const stageLabel: Record<string, string> = {
    collect: "원문 수집 실패",
    classify: "공고 판정 실패",
    extract: "추출 실패",
    verify: "검증 게이트 미통과 (발행 보류)",
  };
  return `${stageLabel[result.stage] ?? result.stage}: ${result.reason}`;
}

function dday(iso: string | null): string {
  if (!iso) return "상시/미확인";
  const diff = Math.ceil((new Date(`${iso}T23:59:59+09:00`).getTime() - Date.now()) / 86_400_000);
  return diff < 0 ? "마감" : `D-${diff}`;
}

async function commandAnalyze(flags: Flags): Promise<number> {
  const url = flags.positional[0];
  if (!url) {
    log("사용법: npm run analyze -- <공고 URL> [--profile examples/profile.pre-seoul.json] [--json] [--no-cache] [--no-progress]");
    return 1;
  }
  log(`공고 분석 시작: ${url}`);
  const result = await runAnalysis(url, flags);
  if (!result.ok) {
    log(`✗ ${describeFailure(result)}`);
    if (result.stage === "verify") log("  검증을 통과하지 못한 브리프는 발행하지 않습니다 (fail-closed).");
    return result.not_a_program ? 2 : 3;
  }

  let match;
  if (flags.profile) {
    const profile = await loadProfile(flags.profile);
    match = { profile, result: matchProfile(result.brief, profile) };
  }
  const markdown = renderMarkdown(result.brief, match);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result.brief, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderTerminal(result.brief, match)}\n`);
  }
  const saved = await saveBrief(result.brief, flags.out, markdown);
  log(`\n저장됨: ${saved}`);
  return 0;
}

async function commandToday(flags: Flags): Promise<number> {
  if (!flags.profile) {
    log("사용법: npm run today -- --profile examples/profile.pre-seoul.json [--urls urls.txt] [--top 5]");
    return 1;
  }
  const profile = await loadProfile(flags.profile);
  const urlsFile = flags.urls ?? "urls.txt";
  const urls = (await readFile(urlsFile, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (urls.length === 0) {
    log(`${urlsFile} 에 공고 URL 이 없습니다 (한 줄에 하나).`);
    return 1;
  }

  log(`오늘의 브리핑 — 공고 ${urls.length}건 정독 (프로필은 로컬에서만 대조, LLM 미전송)\n`);
  const rows: { brief: Brief; match: ReturnType<typeof matchProfile> }[] = [];
  const failures: string[] = [];
  for (const url of urls) {
    log(`· ${url}`);
    try {
      const result = await runAnalysis(url, flags);
      if (result.ok) rows.push({ brief: result.brief, match: matchProfile(result.brief, profile) });
      else failures.push(`${url} — ${describeFailure(result)}`);
    } catch (error) {
      failures.push(`${url} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const order = { eligible: 0, needs_review: 1, ineligible: 2 } as const;
  rows.sort((a, b) => {
    const byStatus = order[a.match.status] - order[b.match.status];
    if (byStatus !== 0) return byStatus;
    const endA = a.brief.overview.apply_end ?? "9999-12-31";
    const endB = b.brief.overview.apply_end ?? "9999-12-31";
    return endA.localeCompare(endB);
  });

  const statusLabel = { eligible: "지원 가능성 높음", needs_review: "확인 필요", ineligible: "지원 불가" } as const;
  process.stdout.write(`━━━ 오늘 확인해야 할 공고 ━━━\n\n`);
  rows.slice(0, flags.top).forEach(({ brief, match }, rank) => {
    const o = brief.overview;
    const amount = o.amount_max_krw ? `최대 ${Math.round(o.amount_max_krw / 10_000).toLocaleString()}만원` : (o.amount_note ?? "");
    process.stdout.write(`${rank + 1}. [${statusLabel[match.status]}] ${o.title}\n`);
    process.stdout.write(`   ${[amount, dday(o.apply_end), o.organizer].filter(Boolean).join(" · ")}\n`);
    const blockers = match.checks.filter((check) => check.status !== "ok");
    for (const check of blockers.slice(0, 3)) {
      process.stdout.write(`   ${check.status === "no" ? "✗" : "?"} ${check.label}${check.detail ? `: ${check.detail}` : ""}\n`);
    }
    const nextAction =
      match.status === "eligible"
        ? `다음 행동: 필요 서류 ${brief.documents.length}건 준비 시작`
        : match.status === "needs_review"
          ? "다음 행동: 미확인 항목을 원문에서 확인"
          : "다음 행동: 미충족 요건 해소 가능 여부 확인";
    process.stdout.write(`   ${nextAction}\n   원문: ${brief.source_url}\n\n`);
  });
  if (failures.length > 0) {
    process.stdout.write(`분석하지 못한 공고 ${failures.length}건:\n`);
    for (const failure of failures) process.stdout.write(`- ${failure}\n`);
  }
  return 0;
}

const { command, flags } = parseArgs(process.argv.slice(2));
const exitCode = await (command === "analyze"
  ? commandAnalyze(flags)
  : command === "today"
    ? commandToday(flags)
    : (async () => {
        log("foundin — 정부지원사업 판단 브리프 에이전트");
        log("  npm run analyze -- <공고 URL> [--profile p.json] [--json] [--no-cache] [--runner solar|claude-code|codex]");
        log("  npm run today   -- --profile p.json [--urls urls.txt] [--top 5]");
        return 1;
      })());
process.exit(exitCode);
