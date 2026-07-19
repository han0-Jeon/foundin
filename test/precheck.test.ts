import { describe, expect, it } from "vitest";
import {
  announcementScore,
  classifyDomain,
  levenshtein,
  precheck,
  registrableDomain,
  scanRiskSignals,
  type PrecheckDeps,
} from "../src/collect/precheck.js";
import type { SourceDocument } from "../src/types.js";

function doc(text: string, url = "https://example.com/notice"): SourceDocument[] {
  return [{ url, kind: "html", title: null, text }];
}

// 공고 패턴 3개 이상 충족하는 본문 (pass_fast 조건)
const NOTICE_TEXT = "모집공고. 지원대상: 창업 7년 이내 기업. 접수기간: 2026-08-14 까지. 신청방법: 온라인. 제출서류: 사업계획서 1부.";

describe("도메인 티어 — 라벨 경계 엄격", () => {
  it("*.go.kr 은 Tier1, 라벨 경계를 넘는 evilgo.kr 은 아니다", () => {
    expect(classifyDomain("https://www.k-startup.go.kr/notice/1").tier).toBe("tier1");
    expect(classifyDomain("https://bizinfo.go.kr/a").tier).toBe("tier1");
    // "evilgo.kr" 은 ".go.kr" 로 끝나지 않는다 → Tier1 아님
    expect(classifyDomain("https://evilgo.kr/notice").tier).not.toBe("tier1");
    // 진짜 하위도메인 evil.go.kr 은 정부만 등록 가능 → Tier1
    expect(classifyDomain("https://evil.go.kr/notice").tier).toBe("tier1");
  });

  it("공공 화이트리스트(비 go.kr)도 Tier1", () => {
    expect(classifyDomain("https://www.kocca.kr/main").tier).toBe("tier1");
    expect(classifyDomain("https://kosmes.or.kr/nsh").tier).toBe("tier1");
  });

  it("일반 도메인은 Tier2", () => {
    expect(classifyDomain("https://greenbiz-lab.or.kr/apply").tier).toBe("tier2");
    expect(classifyDomain("https://some-foundation.com/notice").tier).toBe("tier2");
  });
});

describe("도메인 티어 — Tier3 하드 반려", () => {
  it("IP 리터럴", () => {
    expect(classifyDomain("http://203.0.113.9/notice").tier).toBe("tier3");
  });
  it("비표준 포트", () => {
    expect(classifyDomain("https://foo.com:8443/notice").tier).toBe("tier3");
    // 표준 포트 명시는 Tier3 아님
    expect(classifyDomain("https://foo-fund.com:443/notice").tier).not.toBe("tier3");
  });
  it("punycode(xn--) 호스트", () => {
    expect(classifyDomain("https://xn--k-startup-abc.kr/notice").tier).toBe("tier3");
  });
});

describe("유사 도메인(lookalike) — 편집거리 ≤2", () => {
  it("k-startup.co.kr 은 공공 도메인 위장으로 반려", () => {
    const verdict = classifyDomain("https://k-startup.co.kr/notice");
    expect(verdict.tier).toBe("tier3");
    expect(verdict.reason).toMatch(/유사/);
  });
  it("라벨 변형 k-startup1 도 반려", () => {
    expect(classifyDomain("https://k-startup1.com/notice").tier).toBe("tier3");
  });
  it("편집거리가 먼 정상 도메인은 통과(Tier2)", () => {
    expect(classifyDomain("https://chungnam-technopark.com/notice").tier).toBe("tier2");
  });

  it("편집거리 계산", () => {
    expect(levenshtein("k-startup.go.kr", "k-startup.co.kr")).toBe(1);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });

  it("등록 도메인 추출 (.kr 2단계 처리)", () => {
    expect(registrableDomain("www.k-startup.go.kr")).toBe("k-startup.go.kr");
    expect(registrableDomain("sub.example.com")).toBe("example.com");
  });
});

describe("위험 신호 스캔 (전 티어)", () => {
  it("선입금·계좌 송금·주민번호·텔레그램 유도를 잡는다", () => {
    expect(scanRiskSignals("지원금 신청 전 선입금 30만원을 입금하세요")).toMatch(/선입금|수수료/);
    expect(scanRiskSignals("아래 계좌로 수수료를 송금해 주세요")).not.toBeNull();
    expect(scanRiskSignals("신청서에 주민등록번호를 기재하여 제출")).toMatch(/주민등록번호/);
    expect(scanRiskSignals("자세한 문의는 텔레그램 @gov_fund 로 연락")).toMatch(/텔레그램/);
  });
  it("정상 공고 본문은 위험 신호 없음", () => {
    expect(scanRiskSignals(NOTICE_TEXT)).toBeNull();
  });

  it("공고 긍정 패턴 스코어", () => {
    expect(announcementScore(NOTICE_TEXT)).toBeGreaterThanOrEqual(3);
    expect(announcementScore("회사 소개 페이지입니다. 연혁과 비전을 안내합니다.")).toBeLessThan(3);
  });
});

describe("precheck() 판정", () => {
  const offline: PrecheckDeps = { skipAgeCheck: true };

  it("Tier1 + 공고 패턴 → pass_fast", async () => {
    const result = await precheck("https://www.k-startup.go.kr/notice/1", doc(NOTICE_TEXT), offline);
    expect(result).toMatchObject({ verdict: "pass_fast", tier: "tier1" });
  });

  it("Tier1 이지만 공고 패턴 부족 → needs_llm", async () => {
    const result = await precheck("https://www.k-startup.go.kr/main", doc("기관 소개와 조직도 안내"), offline);
    expect(result).toMatchObject({ verdict: "needs_llm", tier: "tier1" });
  });

  it("Tier3 도메인 → reject (본문 무관)", async () => {
    const result = await precheck("http://203.0.113.9/notice", doc(NOTICE_TEXT), offline);
    expect(result.verdict).toBe("reject");
    expect(result.tier).toBe("tier3");
  });

  it("위험 신호는 Tier1 공공 도메인이라도 reject (pass_fast 보다 우선)", async () => {
    const phishing = `${NOTICE_TEXT} 신청 전 보증금을 아래 계좌로 입금하세요.`;
    const result = await precheck("https://www.k-startup.go.kr/notice/1", doc(phishing), offline);
    expect(result.verdict).toBe("reject");
    expect(result.reason).toMatch(/입금|계좌|선입금/);
  });

  it("첨부(신청서 양식)의 주민번호 동의·계좌 기재란은 위험 신호로 잡지 않는다 (랜딩 문서만 스캔)", async () => {
    const documents = [
      ...doc(NOTICE_TEXT, "https://www.k-startup.go.kr/notice/1"),
      {
        url: "https://www.k-startup.go.kr/afile/form.hwpx",
        kind: "hwpx" as const,
        title: "신청서 양식",
        text: "개인정보 수집·이용 동의: 주민등록번호를 기재하여 제출합니다. 지원금 입금 계좌: (은행/계좌번호)",
      },
    ];
    const result = await precheck("https://www.k-startup.go.kr/notice/1", documents, offline);
    expect(result.verdict).toBe("pass_fast");
  });

  it("Tier2 → needs_llm (pass_fast 대상 아님)", async () => {
    const result = await precheck("https://some-foundation.com/notice", doc(NOTICE_TEXT), offline);
    expect(result).toMatchObject({ verdict: "needs_llm", tier: "tier2" });
  });
});

describe("precheck() Tier2 도메인 나이 검사", () => {
  const FIXED_NOW = Date.parse("2026-07-19T00:00:00Z");

  function rdapFetch(registrationIso: string): typeof fetch {
    return (async () =>
      new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: registrationIso }] }), {
        status: 200,
      })) as unknown as typeof fetch;
  }

  it("신생 도메인(90일 미만) → reject", async () => {
    const deps: PrecheckDeps = { now: () => FIXED_NOW, fetchImpl: rdapFetch("2026-07-09T00:00:00Z") };
    const result = await precheck("https://new-fund-2026.com/notice", doc(NOTICE_TEXT), deps);
    expect(result.verdict).toBe("reject");
    expect(result.tier).toBe("tier2");
    expect(result.reason).toMatch(/신생 도메인/);
  });

  it("오래된 도메인(90일 이상) → 통과(needs_llm)", async () => {
    const deps: PrecheckDeps = { now: () => FIXED_NOW, fetchImpl: rdapFetch("2024-01-01T00:00:00Z") };
    const result = await precheck("https://old-fund.com/notice", doc(NOTICE_TEXT), deps);
    expect(result.verdict).toBe("needs_llm");
  });

  it("조회 실패는 fail-open (통과)", async () => {
    const logs: string[] = [];
    const deps: PrecheckDeps = {
      now: () => FIXED_NOW,
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      onLog: (m) => logs.push(m),
    };
    const result = await precheck("https://maybe-new.com/notice", doc(NOTICE_TEXT), deps);
    expect(result.verdict).toBe("needs_llm"); // 반려하지 않는다
    expect(logs.some((l) => /fail-open/.test(l))).toBe(true);
  });

  it(".kr 은 KISA 키 없으면 나이 검사 생략(fail-open)", async () => {
    const deps: PrecheckDeps = {
      now: () => FIXED_NOW,
      kisaWhoisKey: "",
      fetchImpl: (async () => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    };
    const result = await precheck("https://greenbiz-lab.or.kr/apply", doc(NOTICE_TEXT), deps);
    expect(result.verdict).toBe("needs_llm");
  });
});
