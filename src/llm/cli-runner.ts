import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompleteRequest, LlmRunner } from "./runner.js";

// 구독 CLI 러너 — Solar 무료 기간 종료 시 대안 (solar-pro4 는 정식 출시와 함께 유료 전환 예정).
// claude -p / codex exec 를 서브프로세스로 호출한다 (OAuth 구독 인증, 직접 과금 API 없음).
// 프롬프트는 argv 대신 stdin 으로 전달한다 (긴 한국어 프롬프트의 셸 이스케이프 문제 회피).

const TIMEOUT_MS = 10 * 60 * 1000;
const CHILD_ENV_ALLOWLIST = [
  "appdata",
  "claude_config_dir",
  "codex_home",
  "comspec",
  "home",
  "lang",
  "localappdata",
  "path",
  "pathext",
  "programdata",
  "systemroot",
  "temp",
  "tmp",
  "tmpdir",
  "userprofile",
  "windir",
  "xdg_config_home",
] as const;

function isolatedChildEnv(): NodeJS.ProcessEnv {
  const allowed = new Set<string>(CHILD_ENV_ALLOWLIST);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toLowerCase())) env[key] = value;
  }
  return env;
}

export class CliRunner implements LlmRunner {
  readonly name: string;
  private bin: string;
  private args: string[];

  constructor(kind: "claude-code" | "codex") {
    if (kind === "claude-code") {
      this.bin = process.env.CLAUDE_CODE_BIN ?? "claude";
      this.args = [
        "-p",
        "--output-format",
        "text",
        "--safe-mode",
        "--tools",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--disable-slash-commands",
      ];
      this.name = "claude-code";
    } else {
      this.bin = process.env.CODEX_BIN ?? "codex";
      this.args = [
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
        "-c",
        "mcp_servers={}",
        "--disable",
        "shell_tool",
        "--disable",
        "unified_exec",
        "--disable",
        "web_search",
        "--disable",
        "web_search_request",
        "--disable",
        "standalone_web_search",
        "--disable",
        "apps",
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "-",
      ];
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

    req.onActivity?.(`${this.name} 응답 대기 — 원문 ${prompt.length.toLocaleString()}자 전달`);

    const isolatedCwd = await mkdtemp(join(tmpdir(), "foundin-cli-runner-"));
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(this.bin, this.args, {
          cwd: isolatedCwd,
          env: isolatedChildEnv(),
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
    } finally {
      await rm(isolatedCwd, { recursive: true, force: true });
    }
  }
}
