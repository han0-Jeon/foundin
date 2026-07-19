import { spawn } from "node:child_process";
import type { CompleteRequest, LlmRunner } from "./runner.js";

// 구독 CLI 러너 — Solar 베타 종료(2026-08-01) 후 폴백.
// claude -p / codex exec 를 서브프로세스로 호출한다 (OAuth 구독 인증, 직접 과금 API 없음).
// 프롬프트는 argv 대신 stdin 으로 전달한다 (긴 한국어 프롬프트의 셸 이스케이프 문제 회피).

const TIMEOUT_MS = 10 * 60 * 1000;

export class CliRunner implements LlmRunner {
  readonly name: string;
  private bin: string;
  private args: string[];

  constructor(kind: "claude-code" | "codex") {
    if (kind === "claude-code") {
      this.bin = process.env.CLAUDE_CODE_BIN ?? "claude";
      this.args = ["-p", "--output-format", "text"];
      this.name = "claude-code";
    } else {
      this.bin = process.env.CODEX_BIN ?? "codex";
      this.args = ["exec", "--skip-git-repo-check", "-"];
      this.name = "codex";
    }
  }

  async complete(req: CompleteRequest): Promise<string> {
    const prompt = [
      req.system ? `<system>\n${req.system}\n</system>` : "",
      req.user,
      req.json ? "\n\n응답은 반드시 JSON 하나만 출력한다. 마크다운 펜스·설명 금지." : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.bin, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${this.name} 러너 타임아웃 (${TIMEOUT_MS / 1000}s)`));
      }, TIMEOUT_MS);

      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`${this.name} 실행 실패: ${error.message} (CLI 설치·로그인 상태 확인)`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) resolve(stdout);
        else reject(new Error(`${this.name} 종료 코드 ${code}: ${stderr.slice(0, 300)}`));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
