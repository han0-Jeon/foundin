// hermes 편집국 "심사역" 워커 — foundin.kr 의 brief_queue 를 폴링해 브리프를 생산한다.
//
// API 계약 (foundin.kr 쪽 구현과 동기):
//   POST {FOUNDIN_BASE_URL}/api/worker/briefs/claim   → 200 {job:{id, source_url, program_id|null}} | 204(잡 없음)
//   POST {FOUNDIN_BASE_URL}/api/worker/briefs/submit  → {job_id, status, brief?, reason?}
//     status: published(검증 통과) | rejected(공고 아님) | held(검증 게이트 미통과) | failed(수집·추출 실패)
// 인증: Authorization: Bearer {BRIEF_WORKER_SECRET}

import { analyzeUrl } from "./agent/orchestrator.js";
import { loadDotEnv } from "./env.js";
import { createRunner } from "./llm/runner.js";

loadDotEnv();

const BASE_URL = (process.env.FOUNDIN_BASE_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.BRIEF_WORKER_SECRET ?? "";
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 3));
const IDLE_POLL_MS = 20_000;

if (!BASE_URL || !SECRET) {
  console.error("FOUNDIN_BASE_URL / BRIEF_WORKER_SECRET 이 필요합니다 (.env).");
  process.exit(1);
}

let running = true;
process.on("SIGINT", () => {
  console.log("\n종료 신호 수신 — 진행 중 잡을 마치고 멈춥니다.");
  running = false;
});

function log(lane: number, message: string): void {
  console.log(`${new Date().toISOString()} [lane${lane}] ${message}`);
}

async function api(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

interface Job {
  id: string;
  source_url: string;
  program_id: string | null;
}

async function claim(): Promise<Job | null> {
  const response = await api("/api/worker/briefs/claim", {});
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`claim HTTP ${response.status}`);
  const data = (await response.json()) as { job?: Job };
  return data.job ?? null;
}

async function lane(laneId: number): Promise<void> {
  const runner = await createRunner();
  while (running) {
    let job: Job | null = null;
    try {
      job = await claim();
    } catch (error) {
      log(laneId, `claim 실패: ${error instanceof Error ? error.message : error}`);
    }
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS + Math.random() * 5_000));
      continue;
    }

    log(laneId, `잡 수령 ${job.id}: ${job.source_url}`);
    const started = Date.now();
    try {
      const result = await analyzeUrl(job.source_url, {
        runner,
        onStep: (step) => log(laneId, `  ${job!.id} ${step}`),
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const payload = result.ok
        ? { job_id: job.id, status: "published", brief: result.brief, duration_s: Number(seconds) }
        : {
            job_id: job.id,
            status: result.not_a_program ? "rejected" : result.stage === "verify" ? "held" : "failed",
            reason: result.reason,
            duration_s: Number(seconds),
          };
      const submitted = await api("/api/worker/briefs/submit", payload);
      if (!submitted.ok) throw new Error(`submit HTTP ${submitted.status}`);
      log(laneId, `잡 완료 ${job.id} → ${"status" in payload ? payload.status : "?"} (${seconds}s)`);
    } catch (error) {
      log(laneId, `잡 실패 ${job.id}: ${error instanceof Error ? error.message : error}`);
      await api("/api/worker/briefs/submit", {
        job_id: job.id,
        status: "failed",
        reason: String(error instanceof Error ? error.message : error).slice(0, 500),
      }).catch(() => {});
    }
  }
}

console.log(`foundin 심사역 워커 시작 — ${BASE_URL}, 동시성 ${CONCURRENCY}`);
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => lane(i + 1)));
console.log("워커 종료");
