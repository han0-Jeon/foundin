import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisResult } from "./types.js";

// LLM 캐싱 원칙: 동일 공고 + 동일 모델 = 결과 재사용.

const CACHE_DIR = ".cache";

function keyFor(url: string, model: string): string {
  return createHash("sha1").update(`${model}\n${url}`).digest("hex");
}

export async function readCache(url: string, model: string): Promise<AnalysisResult | null> {
  try {
    const raw = await readFile(join(CACHE_DIR, `${keyFor(url, model)}.json`), "utf8");
    return JSON.parse(raw) as AnalysisResult;
  } catch {
    return null;
  }
}

export async function writeCache(url: string, model: string, result: AnalysisResult): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(join(CACHE_DIR, `${keyFor(url, model)}.json`), JSON.stringify(result, null, 2), "utf8");
  } catch {
    // 캐시 실패는 non-fatal
  }
}
