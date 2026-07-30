import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as fetchModule from "../src/collect/fetch.js";
import { CliRunner } from "../src/llm/cli-runner.js";
import { evidenceSchema } from "../src/types.js";

const originalEnv = { ...process.env };
const probeDirs: string[] = [];

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  for (const dir of probeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SSRF DNS 고정", () => {
  it("검증한 IP만 실제 연결 lookup에 반환한다", async () => {
    const factory = (fetchModule as unknown as {
      createPinnedLookup?: (target: { address: string; family: 4 | 6 }) => Function;
    }).createPinnedLookup;
    expect(factory).toBeTypeOf("function");

    const pinnedLookup = factory!({ address: "203.0.113.7", family: 4 });
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      pinnedLookup("attacker.example", {}, (error: Error | null, address: string, family: number) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });

    expect(result).toEqual({ address: "203.0.113.7", family: 4 });
  });

  it("16진수 IPv4-mapped IPv6 루프백도 차단한다", async () => {
    await expect(
      fetchModule.guardedFetch("http://[::ffff:7f00:1]/secret", { timeoutMs: 100 }),
    ).rejects.toThrow(/사설|비공개/);
  });
});

describe.runIf(process.platform === "win32")("구독 CLI 격리", () => {
  function makeProbe(): string {
    const dir = mkdtempSync(join(tmpdir(), "foundin-cli-probe-"));
    probeDirs.push(dir);
    const path = join(dir, "probe.cmd");
    writeFileSync(
      path,
      "@echo off\r\necho CWD=%CD%\r\necho SECRET=%BRIEF_WORKER_SECRET%\r\necho AWS=%AWS_SECRET_ACCESS_KEY%\r\necho ARGS=%*\r\n",
      "utf8",
    );
    return path;
  }

  async function runProbe(kind: "claude-code" | "codex") {
    const envName = kind === "claude-code" ? "CLAUDE_CODE_BIN" : "CODEX_BIN";
    process.env[envName] = makeProbe();
    process.env.BRIEF_WORKER_SECRET = "must-not-reach-child";
    process.env.AWS_SECRET_ACCESS_KEY = "must-not-reach-child-either";
    const output = await new CliRunner(kind).complete({ user: "untrusted document text" });
    const cwd = output.match(/^CWD=(.+)$/m)?.[1]?.trim();
    expect(cwd).toBeTruthy();
    expect(normalize(cwd!)).not.toBe(normalize(process.cwd()));
    expect(existsSync(cwd!)).toBe(false);
    expect(output).not.toContain("must-not-reach-child");
    return output;
  }

  it("Claude Code를 빈 임시 작업공간과 제한된 도구 설정으로 실행한다", async () => {
    const output = await runProbe("claude-code");
    expect(output).toContain("--tools");
    expect(output).toContain("--strict-mcp-config");
    expect(output).toContain("--no-session-persistence");
    expect(output).toContain("--disable-slash-commands");
  });

  it("Codex를 읽기 전용·승인 없음·임시 세션으로 실행한다", async () => {
    const output = await runProbe("codex");
    expect(output).toContain("--sandbox read-only");
    expect(output).toContain("--ask-for-approval never");
    expect(output).toContain("--ephemeral");
    expect(output).toContain("--ignore-user-config");
    expect(output).toContain("--ignore-rules");
    expect(output).toContain("--disable shell_tool");
    expect(output.indexOf("--ask-for-approval never")).toBeLessThan(output.indexOf("exec"));
  });
});

describe("게시 경계 URL 검증", () => {
  it("근거 URL은 HTTP(S)만 허용한다", () => {
    expect(
      evidenceSchema.safeParse({ quote: "충분히 긴 근거 문장", source_url: "javascript:alert(1)" }).success,
    ).toBe(false);
    expect(
      evidenceSchema.safeParse({ quote: "충분히 긴 근거 문장", source_url: "https://example.go.kr/a" }).success,
    ).toBe(true);
  });
});
