import { describe, expect, it } from "vitest";
import {
  StepTracker,
  createProgress,
  displayWidth,
  formatElapsed,
  shouldAnimate,
  sunriseGauge,
  truncate,
} from "../src/ui/progress.js";

/** TTY 여부를 흉내내는 최소 스트림. */
function fakeStream(isTTY: boolean, columns = 80) {
  const chunks: string[] = [];
  const stream = {
    isTTY,
    columns,
    write(text: string) {
      chunks.push(text);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, chunks, get output() { return chunks.join(""); } };
}

describe("displayWidth — 한글은 2칸", () => {
  it("ASCII 는 1칸", () => {
    expect(displayWidth("abc")).toBe(3);
  });

  it("한글은 글자당 2칸", () => {
    expect(displayWidth("수집")).toBe(4);
    expect(displayWidth("프리체크")).toBe(8);
  });

  it("섞여 있으면 합산", () => {
    expect(displayWidth("추출 3건")).toBe(4 + 1 + 1 + 2);
  });
});

describe("truncate — 표시 폭 기준 자르기", () => {
  it("짧으면 그대로", () => {
    expect(truncate("수집", 10)).toBe("수집");
  });

  it("넘치면 … 을 붙인다", () => {
    const out = truncate("원문과 첨부를 수집하는 중입니다", 10);
    expect(out.endsWith("…")).toBe(true);
    expect(displayWidth(out)).toBeLessThanOrEqual(10);
  });

  it("폭 0 이하는 빈 문자열", () => {
    expect(truncate("수집", 0)).toBe("");
  });
});

describe("formatElapsed", () => {
  it("60초 미만은 소수 첫째자리 초", () => {
    expect(formatElapsed(1234)).toBe("1.2s");
    expect(formatElapsed(59_900)).toBe("59.9s");
  });

  it("60초 이상은 분·초", () => {
    expect(formatElapsed(84_000)).toBe("1m 24s");
    expect(formatElapsed(600_000)).toBe("10m 00s");
  });
});

describe("sunriseGauge — 해가 떠오르는 게이지", () => {
  it("0 이면 전부 빈 칸", () => {
    expect(sunriseGauge(0, 7)).toBe("░░░░░░░");
  });

  it("전부 차면 빈 칸이 없다", () => {
    expect(sunriseGauge(7, 7)).not.toContain("░");
  });

  it("채워진 칸은 왼쪽에서 오른쪽으로 높아진다 (일출)", () => {
    const blocks = "▁▂▃▄▅▆▇█";
    const gauge = sunriseGauge(7, 7);
    const heights = [...gauge].map((c) => blocks.indexOf(c));
    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]!).toBeGreaterThan(heights[i - 1]!);
    }
  });

  it("길이는 항상 total 과 같다", () => {
    expect(sunriseGauge(3, 7)).toHaveLength(7);
  });
});

describe("StepTracker — 단계 상태 기계", () => {
  it("같은 단계가 다시 보고되면 줄을 늘리지 않고 detail 만 갱신한다", () => {
    // precheck 는 orchestrator 에서 두 번 보고된다 (두 번째가 '판정 생략' 사유)
    const t = new StepTracker(() => 0);
    t.step("precheck", "출처 도메인·위험신호 프리체크");
    t.step("precheck", "공공 도메인 + 공고 패턴 — Solar 판정 생략");
    const rows = t.rows.filter((r) => r.key === "precheck");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toBe("공공 도메인 + 공고 패턴 — Solar 판정 생략");
    expect(rows[0]!.state).toBe("active");
  });

  it("extract 재시도도 같은 줄을 갱신한다", () => {
    const t = new StepTracker(() => 0);
    t.step("extract", "조건·날짜·서류 추출");
    t.step("extract", "검증 실패 항목 재추출");
    expect(t.rows.filter((r) => r.key === "extract" && r.state !== "pending")).toHaveLength(1);
  });

  it("건너뛴 단계는 skipped 로 남는다 (공공 도메인이면 classify 생략)", () => {
    const t = new StepTracker(() => 0);
    t.step("collect");
    t.step("precheck");
    t.step("extract"); // classify 를 건너뜀
    const classify = t.rows.find((r) => r.key === "classify")!;
    expect(classify.state).toBe("skipped");
    expect(classify.detail).toBe("생략");
  });

  it("앞 단계는 done 으로 닫히고 소요 시간이 남는다", () => {
    let now = 0;
    const t = new StepTracker(() => now);
    t.step("collect");
    now = 1_200;
    t.step("precheck");
    const collect = t.rows.find((r) => r.key === "collect")!;
    expect(collect.state).toBe("done");
    expect(collect.endedAt! - collect.startedAt!).toBe(1_200);
  });

  it("finish 는 진행 중 단계를 완료로 닫는다", () => {
    const t = new StepTracker(() => 0);
    t.step("collect");
    t.finish();
    expect(t.rows.find((r) => r.key === "collect")!.state).toBe("done");
  });

  it("completedCount 는 done + skipped 를 센다", () => {
    const t = new StepTracker(() => 0);
    t.step("collect");
    t.step("precheck");
    t.step("extract"); // classify skipped
    expect(t.completedCount).toBe(3); // collect done, precheck done, classify skipped
  });

  it("모르는 단계 이름은 무시한다", () => {
    const t = new StepTracker(() => 0);
    t.step("nonexistent");
    expect(t.rows.every((r) => r.state === "pending")).toBe(true);
  });
});

describe("shouldAnimate — 비TTY 에서는 애니메이션 금지", () => {
  it("TTY 면 켠다", () => {
    const { stream } = fakeStream(true);
    expect(shouldAnimate(stream)).toBe(true);
  });

  it("TTY 가 아니면 끈다 (파이프·리다이렉트·pm2)", () => {
    const { stream } = fakeStream(false);
    expect(shouldAnimate(stream)).toBe(false);
  });

  it("plain 옵션이면 TTY 여도 끈다 (--no-progress)", () => {
    const { stream } = fakeStream(true);
    expect(shouldAnimate(stream, true)).toBe(false);
  });

  it("CI 환경변수가 있으면 끈다", () => {
    const { stream } = fakeStream(true);
    const original = process.env.CI;
    process.env.CI = "1";
    try {
      expect(shouldAnimate(stream)).toBe(false);
    } finally {
      if (original === undefined) delete process.env.CI;
      else process.env.CI = original;
    }
  });
});

describe("createProgress — 평문 모드 출력 형식 (기존 CLI 와 동일)", () => {
  it("단계마다 경과 시간이 붙은 한 줄씩 쓴다", () => {
    const fake = fakeStream(false);
    let now = 0;
    const p = createProgress({ stream: fake.stream, now: () => now });
    now = 1_000;
    p.step("collect", "원문·첨부 수집");
    now = 2_500;
    p.step("extract", "조건·날짜·서류 추출");
    p.done();
    const lines = fake.output.trimEnd().split("\n");
    expect(lines).toEqual([
      "  [1.0s] collect — 원문·첨부 수집",
      "  [2.5s] extract — 조건·날짜·서류 추출",
    ]);
  });

  it("평문 출력에 ANSI 이스케이프가 섞이지 않는다", () => {
    const fake = fakeStream(false);
    let now = 0;
    const p = createProgress({ stream: fake.stream, now: () => now });
    now = 1_000;
    p.step("collect", "원문·첨부 수집");
    p.done();
    expect(fake.output).toContain("[1.0s] collect — 원문·첨부 수집");
    expect(fake.output).not.toContain("\x1b");
  });

  it("--no-progress 는 TTY 에서도 평문으로 떨어진다", () => {
    const fake = fakeStream(true);
    let now = 0;
    const p = createProgress({ stream: fake.stream, plain: true, now: () => now });
    now = 500;
    p.step("collect", "원문·첨부 수집");
    p.done();
    expect(fake.output).toContain("[0.5s] collect");
    expect(fake.output).not.toContain("\x1b");
  });
});
