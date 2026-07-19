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

/** 캐시 우선 분석 (동일 URL + 동일 모델 = 재사용) */
async function analyze(url: string): Promise<AnalysisResult> {
  const r = await runner();
  const cached = await readCache(url, r.name);
  if (cached) {
    log(`캐시 재사용: ${url}`);
    return cached;
  }
  await throttle(url);
  log(`분석 시작 (수 분 소요): ${url}`);
  const result = await analyzeUrl(url, {
    runner: r,
    fetchOptions: { userAgent: MCP_USER_AGENT },
    onStep: (step) => log(`  ${step}`),
  });
  await writeCache(url, r.name, result);
  return result;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const server = new McpServer({ name: "foundin", version: "0.1.0" });

server.tool(
  "analyze_announcement",
  "정부지원사업 공고 URL 을 정독·검증해 판단 브리프를 만든다. 모든 항목은 원문 인용 대조를 거치며, " +
    "검증 실패 항목은 ? 로 표시된다. 신규 URL 은 4~6분 걸린다 (캐시된 공고는 즉시).",
  { url: z.string().url().describe("공고 원문 URL (http/https)") },
  async ({ url }) => {
    const result = await analyze(url);
    return textResult(result.ok ? renderMcpBrief(result.brief) : renderMcpFailure(result));
  },
);

server.tool(
  "check_eligibility",
  "공고와 사용자 조건을 대조해 지원 가능성(가능/확인 필요/불가)을 판정한다. " +
    "프로필은 이 도구 안에서 규칙 매칭에만 쓰이고 LLM 으로 전송되지 않는다.",
  {
    url: z.string().url().describe("공고 원문 URL"),
    profile: profileSchema.describe(
      "사용자 조건: biz_stage(pre|early|growth|stable), regions[], age, has_biz_reg, industries[]",
    ),
  },
  async ({ url, profile }) => {
    const result = await analyze(url);
    if (!result.ok) return textResult(renderMcpFailure(result));
    return textResult(renderMcpMatch(result.brief, matchProfile(result.brief, profile)));
  },
);

server.tool(
  "today",
  "공고 URL 목록(최대 10개)을 사용자 조건과 대조해 '오늘 볼 공고' 우선순위로 정리한다. " +
    "캐시에 없는 URL 은 건당 수 분 걸리므로 처음엔 소수로 시작할 것.",
  {
    urls: z.array(z.string().url()).min(1).max(10).describe("공고 원문 URL 목록"),
    profile: profileSchema.describe("사용자 조건 (로컬 매칭 전용, LLM 미전송)"),
  },
  async ({ urls, profile }) => {
    const rows: { title: string; status: string; end: string; url: string }[] = [];
    const failures: string[] = [];
    for (const url of urls) {
      const result = await analyze(url);
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
    const lines = [
      "# 오늘 확인할 공고",
      "(프로필은 로컬 매칭 전용 — LLM 미전송)",
      "",
      ...rows.map((r, i) => `${i + 1}. [${r.status}] ${r.title} — 마감 ${r.end}\n   ${r.url}`),
    ];
    if (failures.length > 0) lines.push("", "## 분석하지 못한 공고", ...failures);
    lines.push("", "※ 참고용입니다. 세부 판단은 각 공고의 analyze_announcement 결과와 원문을 확인하세요.");
    return textResult(lines.join("\n"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log("foundin MCP 서버 시작 (stdio) — 도구: analyze_announcement, check_eligibility, today");
