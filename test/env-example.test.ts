import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 재발 방지 가드 (2026-07-19): .env.example 은 git 에 올라가는 "견본"이다.
// 진짜 키를 넣는 실수가 커밋되기 전에 여기서 잡는다.

describe(".env.example 위생", () => {
  const raw = readFileSync(join(__dirname, "../.env.example"), "utf8");

  it("시크릿 키들은 값이 비어 있어야 한다", () => {
    for (const key of ["UPSTAGE_API_KEY", "BRIEF_WORKER_SECRET"]) {
      const line = raw.split(/\r?\n/).find((l) => l.replace(/^#\s*/, "").startsWith(`${key}=`));
      expect(line, `${key} 줄이 견본에 있어야 함`).toBeTruthy();
      expect(line!.replace(/^#\s*/, ""), `${key} 에 실제 값이 들어가면 안 됨`).toBe(`${key}=`);
    }
  });

  it("Upstage 키 패턴(up_...)이 어디에도 없어야 한다", () => {
    expect(raw).not.toMatch(/up_[A-Za-z0-9]{8,}/);
  });
});
