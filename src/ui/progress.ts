// CLI 진행 표시 — 단계 체크리스트 + 진행 중 단계의 해 궤적.
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

/**
 * 파이프라인 표준 순서. orchestrator.ts 의 step() 호출과 맞춰야 한다.
 *
 * preview 는 아직 시작하지 않은 단계에 흐리게 띄운다. 추출이 몇 분씩 걸리는 동안
 * 아래 세 줄이 라벨만 덩그러니 있으면 화면이 죽어 보인다 — 무엇이 남았는지 알려준다.
 */
const STEPS: { key: string; label: string; preview: string }[] = [
  { key: "collect", label: "수집", preview: "원문·첨부 가져오기" },
  { key: "precheck", label: "프리체크", preview: "출처·위험신호 검사" },
  { key: "classify", label: "판정", preview: "공고 여부 판정" },
  { key: "extract", label: "추출", preview: "조건·날짜·서류 추출" },
  { key: "verify", label: "검증", preview: "인용을 원문과 대조" },
  { key: "advise", label: "조언", preview: "처지별 판단 코멘트" },
  { key: "assemble", label: "조립", preview: "브리프 조립" },
];

/**
 * 회전하는 해. 전부 단폭(single-width) 문자라 한글과 섞여도 열이 안 밀린다.
 *
 * 글리프 선정은 실측 기반이다 — U+2591(░)은 Git Bash 기본 폰트에서 흰 덩어리로,
 * U+2600(☀)은 ○ 로 대체됐고, 블록(U+2581~2588)은 붙여 쓰면 하나로 뭉쳐 보였다.
 * 그래서 화면의 움직이는 부분은 전부 ASCII 로 낮췄고, 여기 스피너만 실측으로
 * 정상 렌더가 확인된 U+25D0~U+25D3 을 쓴다.
 */
const SPINNER = ["◐", "◓", "◑", "◒"];

/** 해의 코어가 숨쉬는 모양. 매 프레임 깜빡이면 죽은 픽셀처럼 보여 주기를 늦춘다. */
const CORE = ["*", "+", "x", "+"];

const FRAME_MS = 120;
const LABEL_WIDTH = 10;
/** 진행 중 단계 오른쪽에 도는 해의 궤적 폭. */
const TRAIL_WIDTH = 12;
/**
 * 모션 주기를 서로소로 잡아 합성 주기를 길게 만든다.
 * LCM(4, 23, 7, 11) = 7,084 프레임 ≈ 14분 — 9분짜리 추출에서도 같은 화면이 다시 오지 않는다.
 * (등속 반복이 눈에 띄면 "정지한 화면"으로 읽힌다.)
 */
const PERIOD = { spin: 4, travel: 23, core: 7, ray: 11 };

type StepState = "pending" | "active" | "done" | "skipped";

interface StepRow {
  key: string;
  label: string;
  /** 아직 시작 전인 단계에 흐리게 띄우는 예고 문구. */
  preview: string;
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
  /** 애니메이션 한 프레임 진행 (테스트·미리보기용. 실사용에선 내부 타이머가 부른다). */
  tick(): void;
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

/**
 * 1.2s / 1m 24s.
 *
 * precise=true 면 분 단위에서도 0.1초를 남긴다(2m 14.3s). 진행 중인 단계에만 쓴다 —
 * 몇 분씩 걸리는 구간에서 매 프레임 바뀌는 유일한 "정보"라서, 이게 없으면 화면이 멎어 보인다.
 * 완료된 단계는 precise=false 로 깔끔하게 둔다.
 */
export function formatElapsed(ms: number, precise = false): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (precise) return `${minutes}m ${seconds.toFixed(1).padStart(4, "0")}s`;
  return `${minutes}m ${String(Math.floor(seconds)).padStart(2, "0")}s`;
}

/**
 * 진행 중 단계 옆에서 도는 해. 배경은 공백으로 비운다 —
 * 점(·)을 깔면 옛 게이지처럼 보여서 "진행률"로 오독된다. 여기엔 진행률 정보가 없다.
 */
export function sunTrail(frame: number, width = TRAIL_WIDTH): string {
  const cells = new Array<string>(width).fill(" ");
  // 좌우 왕복 (반사). 등속 스캔보다 배속 편집에서 잘 읽힌다.
  const span = Math.max(1, (width - 1) * 2);
  const raw = frame % PERIOD.travel % span;
  const pos = raw < width ? raw : span - raw;
  const core = CORE[Math.floor(frame / PERIOD.core) % CORE.length]!;
  // 광선이 뻗었다 줄었다 — 끝에서 한 프레임 멈춘다(숨 참기).
  const spread = [0, 1, 2, 2, 1, 0][Math.floor(frame / PERIOD.ray) % 6]!;
  cells[pos] = core;
  for (let d = 1; d <= spread; d += 1) {
    if (pos - d >= 0 && cells[pos - d] === " ") cells[pos - d] = "-";
    if (pos + d < width && cells[pos + d] === " ") cells[pos + d] = "-";
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
      tick() {},
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
      const spin = SPINNER[frame % PERIOD.spin]!;
      const active = row.state === "active";

      // 1) 색 없는 평문으로 폭을 먼저 확정한다. 색을 입힌 뒤 자르면 이스케이프가 잘려
      //    터미널이 깨지고, 줄이 넘쳐 wrap 되면 커서 되감기(up) 줄 수가 어긋난다.
      let elapsedText = "";
      if (row.state === "done" && row.startedAt !== undefined && row.endedAt !== undefined) {
        elapsedText = formatElapsed(row.endedAt - row.startedAt);
      } else if (active && row.startedAt !== undefined) {
        elapsedText = formatElapsed(now() - row.startedAt, true);
      }

      // 위계를 색이 아니라 위치로 준다. 영상이 압축되거나 흑백으로 캡처돼도 살아남는 신호.
      const gutter = active ? ">" : " ";
      const marker = row.state === "done" ? "✓" : row.state === "skipped" ? "–" : active ? spin : "·";
      const label = padEnd(row.label, LABEL_WIDTH);
      // 대기 단계는 무엇이 남았는지 미리 알려준다 (빈 줄로 두지 않는다).
      const body = row.state === "pending" ? row.preview : row.detail;

      // 들여쓰기 2 + 거터 1 + 공백 1 + 마커 1 + 공백 1 + 라벨 + 공백 1
      const fixed = 2 + 1 + 1 + 1 + 1 + LABEL_WIDTH + 1;
      const trailCost = active ? TRAIL_WIDTH + 2 : 0;
      const tailCost = elapsedText ? elapsedText.length + 2 : 0;
      const detailMax = Math.max(0, columns - fixed - trailCost - tailCost);
      const detail = truncate(body, detailMax);
      const pad = " ".repeat(Math.max(1, detailMax - displayWidth(detail) + 1));

      // 2) 폭이 확정된 뒤에 색만 입힌다 (폭에 영향 없음).
      const markerOut =
        row.state === "done"
          ? paint(ANSI.green, marker)
          : active
            ? paint(ANSI.yellow, marker)
            : paint(ANSI.dim, marker);
      const textOut =
        row.state === "pending" || row.state === "skipped"
          ? paint(ANSI.dim, `${label} ${detail}`.trimEnd())
          : `${label} ${detail}`.trimEnd();
      const trailOut = active ? ` ${paint(ANSI.yellow, sunTrail(frame))} ` : "";
      const tailOut = elapsedText ? `${paint(ANSI.dim, elapsedText)}` : "";
      const spacer = elapsedText || active ? pad : "";
      lines.push(`  ${paint(ANSI.yellow, gutter)} ${markerOut} ${textOut}${spacer}${trailOut}${tailOut}`);
    }

    // 하단은 센 값만 적는다. 남은 시간은 모르므로 모른다고 쓴다 — 진행률 막대를 두지 않는 이유다.
    const total = formatElapsed(now() - startedAt);
    lines.push("");
    lines.push(
      paint(
        ANSI.dim,
        `    ${tracker.completedCount}/${STEPS.length} 단계 완료 · 경과 ${total} · 남은 시간은 알 수 없습니다`,
      ),
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
    tick() {
      frame += 1;
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
