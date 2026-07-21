#!/usr/bin/env node
// foundin MCP 서버 (stdio) — experimental (2026-07-19 소프트 오픈).
//
// 어느 MCP 클라이언트(Hermes Agent·Claude Code·Cursor 등)든 foundin 의 검증 파이프라인을
// 도구로 쓸 수 있게 한다. 대화층 에이전트는 사실을 만들지 못하고, 이 도구가 반환하는
// 검증 통과 결과만 전달한다는 것이 구조의 핵심.
//
// 안전 설계 (docs/decisions.md 2026-07-19 5차):
//  · 출력에 담당자 연락처 미포함 · 인용은 데이터 블록 격리 · 참고용 고지 내장 (render-mcp.ts)
//  · UA 를 프로덕션 워커와 분리 (FoundinCLI)
//  · 같은 도메인 연속 요청에 최소 간격 (대량 크롤러화 방지)
//  · stdout 은 MCP 채널 — 모든 로그는 stderr 로만
//
// 실행: npm run mcp  (에이전트 설정에 command 로 등록)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzeUrl } from "./agent/orchestrator.js";
import { renderMcpBrief, renderMcpFailure, renderMcpMatch } from "./brief/render-mcp.js";
import { readCache, writeCache } from "./cache.js";
import { loadDotEnv } from "./env.js";
import { createRunner } from "./llm/runner.js";
import { matchProfile, profileSchema } from "./match/profile.js";
import type { AnalysisResult } from "./types.js";

loadDotEnv();

const MCP_USER_AGENT = "FoundinCLI/0.1 (+https://github.com/han0-Jeon/foundin)";
const DOMAIN_MIN_INTERVAL_MS = 3_000;

const log = (message: string): void => void process.stderr.write(`[foundin-mcp] ${message}\n`);

// 같은 도메인 연속 분석 사이 최소 간격 — 공고 사이트 부하·크롤러화 방지
const lastHitByDomain = new Map<string, number>();
async function throttle(url: string): Promise<void> {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return; // URL 오류는 분석 단계가 사유와 함께 처리
  }
  const wait = (lastHitByDomain.get(host) ?? 0) + DOMAIN_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastHitByDomain.set(host, Date.now());
}

let runnerPromise: ReturnType<typeof createRunner> | null = null;
function runner() {
  runnerPromise ??= createRunner();
  return runnerPromise;
}
type Runner = Awaited<ReturnType<typeof createRunner>>;

// ── 논블로킹 분석 (2026-07-21) ─────────────────────────────────────────────
// 신규 URL 분석은 4~6분 걸린다. 도구가 그동안 블로킹하면 MCP 클라이언트의 호출
// 타임아웃(Hermes 실측 5분, 클라이언트마다 다름)에 걸려 신규 공고는 사실상 항상 실패한다.
// 실제로 대화층 에이전트가 타임아웃 후 "직접 브라우저로 읽어 요약"하는 폴백을 타면서
// 검증 없는 답이 사용자에게 나갔다 — 이 도구의 존재 이유를 무너뜨리는 실패다.
// 그래서 즉시 반환 + 재호출(폴링) 구조로 바꾼다. 결과는 캐시에 남으므로 재호출은 즉답.
const MAX_CONCURRENT_JOBS = 2;

type JobState =
  | { kind: "running"; startedAt: number }
  | { kind: "done"; result: AnalysisResult }
  | { kind: "failed"; error: string };

/** 진행 중/직전 완료 작업 (키: 러너+URL). 완료분은 캐시가 정본이라 여기선 짧게만 산다. */
const jobs = new Map<string, JobState>();

type Outcome =
  | { kind: "ready"; result: AnalysisResult }
  | { kind: "started" }
  | { kind: "running"; elapsedMs: number }
  | { kind: "queued" }
  | { kind: "failed"; error: string };

function runningCount(): number {
  let n = 0;
  for (const job of jobs.values()) if (job.kind === "running") n += 1;
  return n;
}

async function runInBackground(url: string, r: Runner, key: string): Promise<void> {
  try {
    await throttle(url);
    log(`분석 시작 (백그라운드): ${url}`);
    const result = await analyzeUrl(url, {
      runner: r,
      fetchOptions: { userAgent: MCP_USER_AGENT },
      onStep: (step) => log(`  ${step}`),
    });
    await writeCache(url, r.name, result);
    jobs.set(key, { kind: "done", result });
    log(`분석 완료: ${url}`);
  } catch (error) {
    // 백그라운드 예외가 프로세스를 죽이지 않게 여기서 흡수한다 (stdio 채널 보호).
    const message = error instanceof Error ? error.message : String(error);
    jobs.set(key, { kind: "failed", error: message });
    log(`분석 실패: ${url} — ${message}`);
  }
}

/** 캐시 우선 → 진행 중이면 상태 반환 → 없으면 백그라운드 시작. 절대 분석을 기다리지 않는다. */
async function resolve(url: string): Promise<Outcome> {
  const r = await runner();
  const key = `${r.name}::${url}`;

  const cached = await readCache(url, r.name);
  if (cached) {
    jobs.delete(key);
    log(`캐시 재사용: ${url}`);
    return { kind: "ready", result: cached };
  }

  const job = jobs.get(key);
  if (job?.kind === "done") {
    jobs.delete(key);
    return { kind: "ready", result: job.result };
  }
  if (job?.kind === "failed") {
    jobs.delete(key);
    return { kind: "failed", error: job.error };
  }
  if (job?.kind === "running") {
    return { kind: "running", elapsedMs: Date.now() - job.startedAt };
  }

  // 동시 분석 상한 — today 로 10건이 한꺼번에 들어와도 공고 사이트를 때리지 않게.
  if (runningCount() >= MAX_CONCURRENT_JOBS) return { kind: "queued" };

  jobs.set(key, { kind: "running", startedAt: Date.now() });
  void runInBackground(url, r, key);
  return { kind: "started" };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * 미완료 상태 안내. 마지막 줄의 지시가 핵심 — 대화층 에이전트가 기다리는 대신
 * 직접 웹을 읽어 추측 요약으로 때우는 폴백을 명시적으로 금지한다.
 */
function pendingText(url: string, outcome: Outcome): string {
  const head =
    outcome.kind === "started"
      ? "처음 보는 URL 이라 지금 분석을 시작했습니다."
      : outcome.kind === "queued"
        ? "다른 공고를 분석 중이라 대기열에 넣었습니다."
        : `분석이 진행 중입니다 (${Math.floor((outcome as { elapsedMs: number }).elapsedMs / 60000)}분 경과).`;

  return [
    "# 분석 진행 중 — 아직 결과가 없습니다",
    "",
    head,
    "원문 수집부터 인용 대조 검증까지 보통 4~6분 걸립니다.",
    "",
    `대상: ${url}`,
    "",
    "## 다음에 할 일",
    "**같은 URL 로 이 도구를 다시 호출**하면 완료된 브리프를 즉시 받습니다.",
    "",
    "## 중요",
    "아직 검증이 끝나지 않았습니다. 이 시점에 공고 내용을 웹 검색·브라우저로 직접 읽어",
    "추측하거나 요약해서 답하지 마세요. 그렇게 만든 답은 원문 인용 대조를 거치지 않아",
    "이 도구를 쓰는 의미가 사라집니다. 결과가 나올 때까지 기다렸다가 다시 호출하세요.",
  ].join("\n");
}

function failedText(url: string, error: string): string {
  return [
    "# 분석 실패",
    "",
    `대상: ${url}`,
    `사유: ${error.slice(0, 300)}`,
    "",
    "다시 호출하면 재시도합니다. 계속 실패하면 원문 URL 이 유효한지 확인하세요.",
    "실패를 추측으로 메우지 마세요.",
  ].join("\n");
}

const server = new McpServer({ name: "foundin", version: "0.1.0" });

server.tool(
  "analyze_announcement",
  "정부지원사업 공고 URL 을 정독·검증해 판단 브리프를 만든다. 모든 항목은 원문 인용 대조를 거치며, " +
    "검증 실패 항목은 ? 로 표시된다. " +
    "캐시된 공고는 즉시 반환한다. 처음 보는 URL 은 백그라운드 분석을 시작하고 '진행 중'을 바로 반환하므로, " +
    "4~6분 뒤 같은 URL 로 다시 호출하면 완료된 브리프를 받는다. " +
    "'진행 중' 응답을 받았을 때 웹 검색이나 브라우저로 공고를 직접 읽어 추측 답변을 만들지 말 것 — " +
    "검증되지 않은 답이 되어 이 도구를 쓰는 의미가 사라진다.",
  { url: z.string().url().describe("공고 원문 URL (http/https)") },
  async ({ url }) => {
    const outcome = await resolve(url);
    if (outcome.kind === "failed") return textResult(failedText(url, outcome.error));
    if (outcome.kind !== "ready") return textResult(pendingText(url, outcome));
    const { result } = outcome;
    return textResult(result.ok ? renderMcpBrief(result.brief) : renderMcpFailure(result));
  },
);

server.tool(
  "check_eligibility",
  "공고와 사용자 조건을 대조해 지원 가능성(가능/확인 필요/불가)을 판정한다. " +
    "프로필은 이 도구 안에서 규칙 매칭에만 쓰이고 LLM 으로 전송되지 않는다. " +
    "analyze_announcement 와 같은 분석 결과를 쓰므로, 처음 보는 URL 은 '진행 중'을 반환하고 " +
    "4~6분 뒤 재호출하면 판정을 준다. 진행 중일 때 추측으로 판정하지 말 것.",
  {
    url: z.string().url().describe("공고 원문 URL"),
    profile: profileSchema.describe(
      "사용자 조건: biz_stage(pre|early|growth|stable), regions[], age, has_biz_reg, industries[]",
    ),
  },
  async ({ url, profile }) => {
    const outcome = await resolve(url);
    if (outcome.kind === "failed") return textResult(failedText(url, outcome.error));
    if (outcome.kind !== "ready") return textResult(pendingText(url, outcome));
    const { result } = outcome;
    if (!result.ok) return textResult(renderMcpFailure(result));
    return textResult(renderMcpMatch(result.brief, matchProfile(result.brief, profile)));
  },
);

server.tool(
  "today",
  "공고 URL 목록(최대 10개)을 사용자 조건과 대조해 '오늘 볼 공고' 우선순위로 정리한다. " +
    "이미 분석된 공고는 즉시 정리해 주고, 처음 보는 URL 은 백그라운드 분석을 시작한 뒤 '분석 중'으로 표시한다. " +
    "몇 분 뒤 같은 목록으로 다시 호출하면 완성된 순위를 받는다. 분석 중인 공고를 추측으로 채우지 말 것.",
  {
    urls: z.array(z.string().url()).min(1).max(10).describe("공고 원문 URL 목록"),
    profile: profileSchema.describe("사용자 조건 (로컬 매칭 전용, LLM 미전송)"),
  },
  async ({ urls, profile }) => {
    const rows: { title: string; status: string; end: string; url: string }[] = [];
    const pending: string[] = [];
    const failures: string[] = [];

    for (const url of urls) {
      const outcome = await resolve(url);
      if (outcome.kind === "failed") {
        failures.push(`- ${url}: ${outcome.error.slice(0, 80)}`);
        continue;
      }
      if (outcome.kind !== "ready") {
        pending.push(`- ${url}`);
        continue;
      }
      const { result } = outcome;
      if (!result.ok) {
        failures.push(`- ${url}: ${result.reason.slice(0, 80)}`);
        continue;
      }
      const match = matchProfile(result.brief, profile);
      const label = { eligible: "지원 가능성 높음", needs_review: "확인 필요", ineligible: "지원 불가" }[match.status];
      rows.push({
        title: result.brief.overview.title,
        status: label,
        end: result.brief.overview.apply_end ?? "상시/미상",
        url,
      });
    }

    const order = ["지원 가능성 높음", "확인 필요", "지원 불가"];
    rows.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.end.localeCompare(b.end));

    const lines = ["# 오늘 확인할 공고", "(프로필은 로컬 매칭 전용 — LLM 미전송)", ""];
    if (rows.length > 0) {
      lines.push(...rows.map((r, i) => `${i + 1}. [${r.status}] ${r.title} — 마감 ${r.end}\n   ${r.url}`));
    } else {
      lines.push("검증이 끝난 공고가 아직 없습니다.");
    }
    if (pending.length > 0) {
      lines.push(
        "",
        `## 분석 중 (${pending.length}건)`,
        ...pending,
        "",
        "몇 분 뒤 같은 목록으로 다시 호출하면 위 순위에 합쳐집니다.",
        "이 공고들은 아직 검증 전이므로 내용을 추측해 채우지 마세요.",
      );
    }
    if (failures.length > 0) lines.push("", "## 분석하지 못한 공고", ...failures);
    lines.push("", "※ 참고용입니다. 세부 판단은 각 공고의 analyze_announcement 결과와 원문을 확인하세요.");
    return textResult(lines.join("\n"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log("foundin MCP 서버 시작 (stdio) — 도구: analyze_announcement, check_eligibility, today");
