// CLI 진행 표시 — 단계 체크리스트 + 일출 게이지.
//
// 왜 필요한가: extract 단계가 공고에 따라 수 분 걸린다. 그동안 화면이 멈춰 있으면
// 사용자는 죽은 건지 도는 건지 알 수 없다.
//
// 원칙
//   - TTY 가 아니면(파이프·리다이렉트·CI·pm2) 애니메이션을 끄고 기존 한 줄 로그를 그대로 낸다.
//     워커(src/worker.ts)와 MCP(src/mcp.ts)는 이 모듈을 쓰지 않지만, CLI 출력을 파일로 받는
//     경우에도 제어문자가 섞이면 안 된다.
//   - 전부 stderr 로 나간다. stdout 은 브리프 본문(--json 포함) 전용이라 오염시키지 않는다.
//   - 외부 의존성 없음. 스피너·커서 제어는 ANSI 이스케이프 직접 사용.

import { fstatSync } from "node:fs";

/** 파이프라인 표준 순서. orchestrator.ts 의 step() 호출과 맞춰야 한다. */
const STEPS: { key: string; label: string }[] = [
  { key: "collect", label: "수집" },
  { key: "precheck", label: "프리체크" },
  { key: "classify", label: "판정" },
  { key: "extract", label: "추출" },
  { key: "verify", label: "검증" },
  { key: "advise", label: "조언" },
  { key: "assemble", label: "조립" },
];

/** 회전하는 해. 전부 단폭(single-width) 문자라 한글과 섞여도 열이 안 밀린다. */
const SPINNER = ["◐", "◓", "◑", "◒"];
/**
 * 일출 게이지 — 채워진 칸은 점점 높아지는 블록.
 *
 * 빈 칸에 U+2591(░)을, 해에 U+2600(☀)을 썼더니 Git Bash 기본 폰트에서
 * 각각 흰 덩어리와 ○ 로 대체돼 화면이 지저분해졌다(실측). 블록 문자는 잘 나오므로
 * 그대로 두고, 나머지는 Latin-1·ASCII 로 낮춘다.
 */
const BLOCKS = "▁▂▃▄▅▆▇█";
const EMPTY_CELL = "·";
const SUN = "*";

const FRAME_MS = 120;
const LABEL_WIDTH = 10;

type StepState = "pending" | "active" | "done" | "skipped";

interface StepRow {
  key: string;
  label: string;
  detail: string;
  state: StepState;
  startedAt?: number;
  endedAt?: number;
}

export interface ProgressReporter {
  /** orchestrator 의 onStep 에 그대로 연결한다. */
  step(name: string, detail?: string): void;
  /** 정상 종료 — 마지막 상태를 남기고 애니메이션을 멈춘다. */
  done(): void;
  /** 실패 종료 — 진행 중이던 단계를 실패로 표시하고 멈춘다. */
  fail(): void;
}

export interface ProgressOptions {
  /** 기본 process.stderr */
  stream?: NodeJS.WriteStream;
  /** 강제로 평문 모드 (--no-progress) */
  plain?: boolean;
  /** 감지를 무시하고 강제로 애니메이션 (--progress) */
  force?: boolean;
  /** 테스트용 시계 주입 */
  now?: () => number;
}

/** 한글·CJK 를 2칸으로 세는 표시 폭 계산. 이모지는 쓰지 않으므로 이 정도로 충분하다. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    width +=
      (cp >= 0x1100 && cp <= 0x115f) || // 한글 자모
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 부수·한자
      (cp >= 0xac00 && cp <= 0xd7a3) || // 한글 음절
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK 호환
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || // 전각
      (cp >= 0xffe0 && cp <= 0xffe6)
        ? 2
        : 1;
  }
  return width;
}

/** 표시 폭 기준으로 자르고 넘치면 … 을 붙인다. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (displayWidth(text) <= max) return text;
  let out = "";
  let width = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

/** 표시 폭 기준 왼쪽 정렬 패딩. */
function padEnd(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/** 1.2s / 1m 24s. 초 단위 미만은 버린다. */
export function formatElapsed(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * 일출 게이지. 완료 수만큼 왼쪽부터 채우되, 채워진 칸은 왼쪽에서 오른쪽으로
 * 점점 높아진다 (해가 떠오르는 모양).
 */
export function sunriseGauge(completed: number, total: number): string {
  const cells: string[] = [];
  for (let i = 0; i < total; i += 1) {
    if (i < completed) {
      const ratio = total > 1 ? i / (total - 1) : 1;
      const idx = Math.min(BLOCKS.length - 1, Math.round(ratio * (BLOCKS.length - 1)));
      cells.push(BLOCKS[idx]!);
    } else {
      cells.push(EMPTY_CELL);
    }
  }
  return cells.join("");
}

/**
 * 단계 상태 기계. 렌더링과 분리해 두어 테스트가 TTY 없이 가능하다.
 *
 * 같은 단계가 다시 보고되면(extract 재시도, precheck 의 '판정 생략' 보고) 줄을 새로 만들지
 * 않고 detail 만 갱신한다. 건너뛴 단계(공공 도메인이면 classify)는 skipped 로 남겨
 * "프리체크가 Solar 호출을 아꼈다"는 사실이 화면에 보이게 한다.
 */
export class StepTracker {
  readonly rows: StepRow[];
  private activeIndex = -1;

  constructor(private readonly now: () => number = Date.now) {
    this.rows = STEPS.map((s) => ({ ...s, detail: "", state: "pending" as StepState }));
  }

  step(name: string, detail?: string): void {
    const index = this.rows.findIndex((r) => r.key === name);
    if (index === -1) return; // 모르는 단계는 무시 (표준 순서를 신뢰)
    const row = this.rows[index]!;

    if (index === this.activeIndex) {
      if (detail) row.detail = detail;
      return;
    }

    if (this.activeIndex >= 0) {
      const prev = this.rows[this.activeIndex]!;
      prev.state = "done";
      prev.endedAt = this.now();
    }
    // 지나친 단계는 건너뛴 것으로 표시
    for (let i = Math.max(0, this.activeIndex + 1); i < index; i += 1) {
      const skipped = this.rows[i]!;
      if (skipped.state === "pending") {
        skipped.state = "skipped";
        if (!skipped.detail) skipped.detail = "생략";
      }
    }

    row.state = "active";
    row.startedAt = this.now();
    if (detail) row.detail = detail;
    this.activeIndex = index;
  }

  /** 진행 중 단계를 완료로 닫는다. */
  finish(): void {
    if (this.activeIndex < 0) return;
    const row = this.rows[this.activeIndex]!;
    row.state = "done";
    row.endedAt = this.now();
    this.activeIndex = -1;
  }

  /** 진행 중 단계를 실패로 남긴다 (표시만 멈춤). */
  abort(): void {
    if (this.activeIndex < 0) return;
    const row = this.rows[this.activeIndex]!;
    row.endedAt = this.now();
    this.activeIndex = -1;
  }

  get completedCount(): number {
    return this.rows.filter((r) => r.state === "done" || r.state === "skipped").length;
  }

  get visibleRows(): StepRow[] {
    // 아직 시작 안 한 뒤쪽 단계도 흐리게 보여준다 (파이프라인 전체가 눈에 보이도록)
    return this.rows;
  }
}

const ANSI = {
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  clearBelow: "\x1b[0J",
  up: (n: number) => (n > 0 ? `\x1b[${n}A` : ""),
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
};

/**
 * 색을 쓸지. 애니메이션 여부와 같이 간다 — 커서 제어 이스케이프를 쓰기로 한 화면이면
 * 색 이스케이프도 당연히 먹는다. (예전엔 isTTY 를 따로 봤는데, Git Bash 에서 isTTY 가
 * undefined 라 애니메이션은 켜지고 색만 꺼지는 반쪽 상태가 나왔다.)
 */
function useColor(animate: boolean): boolean {
  if (process.env.NO_COLOR) return false;
  return animate;
}

/**
 * 파일로 리다이렉트됐는지 (`> log.txt`). 여기에 제어문자가 들어가면 안 된다.
 *
 * isTTY 는 Windows 의 Git Bash(mintty)에서 undefined 라 믿을 수 없다. mintty 는
 * 콘솔이 아니라 pty 를 파이프로 흉내내기 때문이다. 그래서 "터미널인가"를 맞히는 대신
 * "파일인가"만 확인하고, 파일이 아니면 그리는 쪽으로 간다.
 */
function isRedirectedToFile(stream: NodeJS.WriteStream): boolean {
  const fd = (stream as unknown as { fd?: number }).fd;
  // 주입된 스트림(테스트 더블)은 프로세스 fd 로 대신 판단하면 안 된다 — 파일로 취급.
  if (typeof fd !== "number") return true;
  try {
    return fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

/** FOUNDIN_DEBUG_TTY=1 이면 감지 근거를 찍는다 (사용자 환경 진단용). */
function debugDetection(stream: NodeJS.WriteStream, decision: boolean): void {
  if (!process.env.FOUNDIN_DEBUG_TTY) return;
  let fdKind = "?";
  try {
    const maybeFd = (stream as unknown as { fd?: number }).fd;
    const st = fstatSync(typeof maybeFd === "number" ? maybeFd : 2);
    fdKind = st.isFIFO() ? "FIFO" : st.isFile() ? "FILE" : st.isCharacterDevice() ? "CHAR" : "기타";
  } catch (err) {
    fdKind = `err:${(err as NodeJS.ErrnoException).code ?? "?"}`;
  }
  process.stderr.write(
    `[tty] platform=${process.platform} MSYSTEM=${process.env.MSYSTEM ?? "-"} ` +
      `TERM=${process.env.TERM ?? "-"} isTTY=${String(stream.isTTY)} fd=${fdKind} → 애니메이션=${decision}\n`,
  );
}

/**
 * 애니메이션을 켤지 판단한다.
 * TTY 가 아니거나 CI 환경이면 끈다 — 제어문자가 로그 파일에 섞이는 걸 막는다.
 */
export function shouldAnimate(stream: NodeJS.WriteStream, plain?: boolean, force?: boolean): boolean {
  if (plain) return false;
  if (process.env.FOUNDIN_NO_PROGRESS) return false;
  if (force || process.env.FOUNDIN_PROGRESS) return true; // 감지 실패 시 강제 on
  if (process.env.CI) return false;
  if (stream.isTTY) return true;
  // isTTY 를 못 믿는 환경(Git Bash mintty 등) — 파일로 새지만 않으면 그린다.
  return !isRedirectedToFile(stream);
}

export function createProgress(options: ProgressOptions = {}): ProgressReporter {
  const stream = options.stream ?? process.stderr;
  const now = options.now ?? Date.now;
  const animate = shouldAnimate(stream, options.plain, options.force);
  debugDetection(stream, animate);
  const startedAt = now();

  if (!animate) {
    // 평문 모드 — 기존 CLI 출력과 같은 형식을 유지한다.
    return {
      step(name, detail) {
        const elapsed = ((now() - startedAt) / 1000).toFixed(1);
        stream.write(`  [${elapsed}s] ${name}${detail ? ` — ${detail}` : ""}\n`);
      },
      done() {},
      fail() {},
    };
  }

  const tracker = new StepTracker(now);
  const color = useColor(animate);
  let frame = 0;
  let drawnLines = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const paint = (c: string, text: string): string => (color ? `${c}${text}${ANSI.reset}` : text);

  const render = (): void => {
    const columns = stream.columns && stream.columns > 20 ? stream.columns : 80;
    const lines: string[] = [];

    for (const row of tracker.visibleRows) {
      const spin = SPINNER[frame % SPINNER.length]!;

      // 1) 색 없는 평문으로 폭을 먼저 확정한다. 색을 입힌 뒤 자르면 이스케이프가 잘려
      //    터미널이 깨지고, 줄이 넘쳐 wrap 되면 커서 되감기(up) 줄 수가 어긋난다.
      let elapsedText = "";
      if (row.state === "done" && row.startedAt !== undefined && row.endedAt !== undefined) {
        elapsedText = formatElapsed(row.endedAt - row.startedAt);
      } else if (row.state === "active" && row.startedAt !== undefined) {
        elapsedText = formatElapsed(now() - row.startedAt);
      }

      const marker = row.state === "done" ? "✓" : row.state === "skipped" ? "–" : row.state === "active" ? spin : " ";
      const label = padEnd(row.label, LABEL_WIDTH);
      // 들여쓰기 2 + 마커 1 + 공백 1 + 라벨 + 공백 1 + [detail] + 공백 1 + 경과
      const fixed = 2 + 1 + 1 + LABEL_WIDTH + 1;
      const detailMax = Math.max(0, columns - fixed - (elapsedText ? elapsedText.length + 1 : 0));
      const detail = truncate(row.detail, detailMax);
      const gap = elapsedText ? " ".repeat(Math.max(1, detailMax - displayWidth(detail) + 1)) : "";

      // 2) 폭이 확정된 뒤에 색만 입힌다 (폭에 영향 없음).
      const markerOut =
        row.state === "done"
          ? paint(ANSI.green, marker)
          : row.state === "active"
            ? paint(ANSI.yellow, marker)
            : row.state === "skipped"
              ? paint(ANSI.dim, marker)
              : marker;
      const textOut =
        row.state === "pending" || row.state === "skipped"
          ? paint(ANSI.dim, `${label} ${detail}`.trimEnd())
          : `${label} ${detail}`.trimEnd();
      const tailOut = elapsedText ? `${gap}${paint(ANSI.dim, elapsedText)}` : "";
      lines.push(`  ${markerOut} ${textOut}${tailOut}`);
    }

    const gauge = sunriseGauge(tracker.completedCount, STEPS.length);
    const total = formatElapsed(now() - startedAt);
    lines.push("");
    lines.push(
      `  ${paint(ANSI.yellow, SUN)} ${gauge}  ${tracker.completedCount}/${STEPS.length} · 경과 ${total}`,
    );

    const out = `${ANSI.up(drawnLines)}${ANSI.clearBelow}${lines.join("\n")}\n`;
    stream.write(out);
    drawnLines = lines.length;
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    render();
    stream.write(ANSI.showCursor);
  };

  stream.write(ANSI.hideCursor);
  timer = setInterval(() => {
    frame += 1;
    render();
  }, FRAME_MS);
  if (typeof timer.unref === "function") timer.unref();

  const restore = () => {
    if (!stopped) stream.write(ANSI.showCursor);
  };
  process.once("exit", restore);
  process.once("SIGINT", () => {
    restore();
    process.exit(130);
  });

  return {
    step(name, detail) {
      tracker.step(name, detail);
      render();
    },
    done() {
      tracker.finish();
      stop();
    },
    fail() {
      tracker.abort();
      stop();
    },
  };
}
