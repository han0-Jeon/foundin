// hermes(LG노트북) 편집국 워커 — foundin.kr 의 brief_queue 를 폴링해 브리프를 생산한다.
//
// API 계약 (foundin.kr 쪽 구현과 동기):
//   POST {FOUNDIN_BASE_URL}/api/worker/briefs/claim   → 200 {job:{id, source_url, program_id|null}} | 204(잡 없음)
//   POST {FOUNDIN_BASE_URL}/api/worker/briefs/stage   → STAGE A(수집·판정) 완료 중간 보고 (best-effort)
//   POST {FOUNDIN_BASE_URL}/api/worker/briefs/submit  → {job_id, status, brief?, reason?}
//     status: published(검증 통과) | rejected(공고 아님) | held(검증 게이트 미통과) | failed(수집·추출 실패)
// 인증: Authorization: Bearer {BRIEF_WORKER_SECRET}
//
// 픽업 지연: 기본 20초 폴링 + (선택) Supabase Realtime 구독으로 즉시 깨우기. 둘 다 켜 이중화한다.

import { analyzeUrl, type StageAInfo } from "./agent/orchestrator.js";
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

// 대기 레인을 즉시 깨우는 신호기 — Realtime 이벤트가 오면 폴링 간격을 기다리지 않고 재픽업한다.
class Waker {
  private readonly waiters = new Set<() => void>();
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
  wakeAll(): void {
    for (const done of [...this.waiters]) done();
  }
}

const waker = new Waker();

let running = true;
process.on("SIGINT", () => {
  console.log("\n종료 신호 수신 — 진행 중 잡을 마치고 멈춥니다.");
  running = false;
  waker.wakeAll(); // 대기 중인 레인이 즉시 running=false 를 확인하도록
});

function log(lane: number | string, message: string): void {
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

// STAGE A 중간 보고 — 실패는 non-fatal (분석은 계속된다).
async function reportStage(laneId: number, jobId: string, info: StageAInfo): Promise<void> {
  try {
    const response = await api("/api/worker/briefs/stage", {
      job_id: jobId,
      stage: "classified",
      is_program: info.is_program,
      tier: info.tier,
      reason: info.reason,
    });
    if (!response.ok) log(laneId, `stage 보고 실패(무시) ${jobId}: HTTP ${response.status}`);
  } catch (error) {
    log(laneId, `stage 보고 실패(무시) ${jobId}: ${error instanceof Error ? error.message : error}`);
  }
}

// (선택) Supabase Realtime 구독으로 즉시 깨우기. env 없음·구독 실패 시 20초 폴링으로 폴백.
async function setupRealtime(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    log("rt", "SUPABASE_URL/ANON_KEY 없음 — 20초 폴링만 사용");
    return;
  }
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(url, key, { auth: { persistSession: false } });
    client
      .channel("brief-queue")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "solar_briefs" }, () => waker.wakeAll())
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "solar_briefs", filter: "needs_refresh=eq.true" },
        () => waker.wakeAll(),
      )
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") log("rt", "Realtime 구독 활성 — 픽업 즉시화 (폴링은 폴백 유지)");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") log("rt", `Realtime 구독 이상(${status}) — 20초 폴링 폴백`);
      });
  } catch (error) {
    log("rt", `Realtime 초기화 실패 — 20초 폴링 폴백: ${error instanceof Error ? error.message : error}`);
  }
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
      await waker.wait(IDLE_POLL_MS + Math.random() * 5_000);
      continue;
    }

    log(laneId, `잡 수령 ${job.id}: ${job.source_url}`);
    const started = Date.now();
    try {
      const result = await analyzeUrl(job.source_url, {
        runner,
        onStep: (step) => log(laneId, `  ${job!.id} ${step}`),
        onStageA: (info) => reportStage(laneId, job!.id, info),
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const payload = result.ok
        ? { job_id: job.id, status: "published", brief: result.brief, duration_s: Number(seconds) }
        : {
            job_id: job.id,
            status: result.not_a_program ? "rejected" : result.stage === "verify" ? "held" : "failed",
            reason: result.reason,
            tier: result.tier,
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
await setupRealtime();
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => lane(i + 1)));
console.log("워커 종료");
