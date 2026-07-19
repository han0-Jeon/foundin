// 프리체크 v3 — 도메인 신뢰 기반 피싱 방어 (결정적 코드, LLM 아님).
//
// 원칙: 키워드는 위조 가능(피싱범이 접수·마감 문구를 만들 수 있다), 도메인은 위조 불가
//   (.go.kr 은 정부기관만 등록). 그래서 1차 방어축을 "출처(도메인)"에 둔다.
//   - Tier1: *.go.kr(라벨 경계 엄격) + 공공 화이트리스트 → 공고 패턴까지 맞으면 0초 통과(Solar 판정 생략)
//   - Tier2: 일반 도메인 → 신생 도메인(90일 미만)이면 반려, 아니면 Solar 판정 + "공공 아님" 배지
//   - Tier3: IP 리터럴·punycode·비표준 포트·화이트리스트 유사(편집거리 ≤2) → 즉시 반려
//   - 전 티어 위험신호(선입금·계좌 송금·주민번호·텔레그램 유도) → 즉시 반려
// 한계 인지: 완벽한 피싱 판별은 불가능 — "공공은 빠르게, 비공공은 의심하며, 위험신호는 차단"까지.

import { isIP } from "node:net";
import type { DomainTier, SourceDocument } from "../types.js";

export type PrecheckVerdict = "pass_fast" | "needs_llm" | "reject";

export interface PrecheckResult {
  /** pass_fast = Tier1 + 공고 패턴 → Solar 판정 생략 · needs_llm = Solar 판정 수행 · reject = 비공고 반려 */
  verdict: PrecheckVerdict;
  tier: DomainTier;
  reason?: string;
}

export interface PrecheckDeps {
  fetchImpl?: typeof fetch;
  /** 현재 시각 (도메인 나이 계산용, 테스트 주입) */
  now?: () => number;
  /** 도메인 나이 조회 타임아웃 (기본 4초) */
  timeoutMs?: number;
  /** KISA WHOIS 오픈API 키 (.kr 나이 조회용). 없으면 .kr 나이 검사 생략(fail-open) */
  kisaWhoisKey?: string;
  onLog?: (message: string) => void;
  /** 도메인 나이 검사 비활성 (오프라인·테스트). 기본 false */
  skipAgeCheck?: boolean;
}

// 공공 소스 화이트리스트 — Tier1 자격이자 유사 도메인(lookalike) 판정의 기준 집합.
// *.go.kr 은 endsWith 규칙으로 이미 Tier1 이지만, 편집거리 비교의 기준으로도 필요해 포함한다.
export const PUBLIC_WHITELIST = [
  "k-startup.go.kr", // K-Startup (창업진흥원)
  "bizinfo.go.kr", // 기업마당
  "mss.go.kr", // 중소벤처기업부
  "youthcenter.go.kr", // 온통청년(청년정책)
  "smtech.go.kr", // 중소기업 기술개발종합관리
  "kocca.kr", // 한국콘텐츠진흥원
  "kosmes.or.kr", // 중소벤처기업진흥공단
  "semas.or.kr", // 소상공인시장진흥공단
] as const;

const NEW_DOMAIN_DAYS = 90;
const ANNOUNCEMENT_MIN_HITS = 3;

// ── 도메인 파싱 (라벨 경계 엄격) ──────────────────────────────
// .kr 2단계(go.kr·or.kr 등)는 3라벨을 등록 도메인으로 본다 (간이 Public Suffix).
const KR_SECOND_LEVELS = new Set(["go", "or", "co", "ne", "re", "pe", "ac", "hs", "ms", "es", "sc", "kg"]);

export function registrableDomain(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  if (tld === "kr" && sld && KR_SECOND_LEVELS.has(sld)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

function sldLabel(registrable: string): string {
  return registrable.split(".")[0] ?? registrable;
}

// 편집거리 (Levenshtein, 1D 롤링). 유사 도메인 위장 탐지에 쓴다.
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let diag = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const above = dp[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, diag + cost);
      diag = above;
    }
  }
  return dp[n]!;
}

interface DomainVerdict {
  tier: DomainTier;
  reason?: string; // tier3 일 때만
}

export function classifyDomain(finalUrl: string): DomainVerdict {
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    return { tier: "tier3", reason: "URL 파싱 실패" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  // ── 하드 위험 신호 (무조건 Tier3) ──
  if (isIP(host) !== 0) return { tier: "tier3", reason: "IP 리터럴 호스트 — 공공기관 공고는 도메인을 쓴다" };
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return { tier: "tier3", reason: "punycode(IDN) 호스트 — 호모그래프 위장 가능성" };
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    return { tier: "tier3", reason: `비표준 포트(${url.port}) — 공공 공고에 이례적` };
  }

  // ── Tier1: *.go.kr(라벨 경계 엄격, "evilgo.kr" 차단) 또는 공공 화이트리스트 ──
  const isGoKr = host.endsWith(".go.kr");
  const whitelisted = PUBLIC_WHITELIST.some((w) => host === w || host.endsWith(`.${w}`));
  if (isGoKr || whitelisted) return { tier: "tier1" };

  // ── 유사 도메인 위장: 화이트리스트와 편집거리 ≤2 (k-startup.co.kr / k-startup1.kr 류) ──
  const registrable = registrableDomain(host);
  const label = sldLabel(registrable);
  for (const w of PUBLIC_WHITELIST) {
    const dFull = levenshtein(registrable, w);
    if (dFull >= 1 && dFull <= 2) {
      return { tier: "tier3", reason: `공공 도메인 유사 위장 의심 (${registrable} ≈ ${w}, 편집거리 ${dFull})` };
    }
    const wl = sldLabel(w);
    if (label.length >= 5 && wl.length >= 5) {
      const dLabel = levenshtein(label, wl);
      if (dLabel >= 1 && dLabel <= 2) {
        return { tier: "tier3", reason: `공공기관 명칭 유사 위장 의심 (${label} ≈ ${wl}, 편집거리 ${dLabel})` };
      }
    }
  }

  return { tier: "tier2" };
}

// ── 위험 신호 스캔 (전 티어, 마스킹 전 원문 텍스트 대상) ───────
// 정상 공공 공고에는 없는 패턴. 하나라도 걸리면 즉시 반려한다.
const RISK_SIGNALS: { re: RegExp; reason: string }[] = [
  {
    re: /선\s*입금|보증금.{0,10}(입금|송금|납부)|수수료.{0,10}(입금|송금|납부|결제)/,
    reason: "선입금·수수료 입금 요구 (정상 공공 공고에 없는 패턴)",
  },
  { re: /계좌.{0,12}(입금|송금|이체)|(아래|하단|하기)\s*계좌/, reason: "계좌 입금·송금 유도" },
  { re: /주민\s*등록\s*번호.{0,12}(요구|기재|입력|제출|전송|보내|필요|등록)/, reason: "주민등록번호 요구" },
  { re: /텔레그램|telegram|오픈\s*채팅|오픈\s*카톡|오픈카톡/i, reason: "텔레그램·오픈채팅 개인 연락 유도" },
  { re: /(카카오톡|카톡).{0,12}(개인|1:1|일대일|상담원|친구\s*추가)/, reason: "카카오톡 개인 연락 유도" },
];

export function scanRiskSignals(text: string): string | null {
  for (const signal of RISK_SIGNALS) {
    if (signal.re.test(text)) return signal.reason;
  }
  return null;
}

// ── 공고 긍정 패턴 스코어 ────────────────────────────────────
const ANNOUNCEMENT_PATTERNS = [
  /접수\s*기간/,
  /신청\s*기간/,
  /신청\s*방법/,
  /제출\s*서류/,
  /지원\s*대상/,
  /지원\s*자격/,
  /신청\s*자격/,
  /모집\s*공고/,
  /공고문/,
  /사업\s*개요/,
  /지원\s*내용/,
  /지원\s*규모/,
  /마감/,
];

export function announcementScore(text: string): number {
  return ANNOUNCEMENT_PATTERNS.reduce((count, re) => (re.test(text) ? count + 1 : count), 0);
}

// ── Tier2 도메인 나이 검사 (fail-open) ───────────────────────
function pad(value: string): string {
  return value.padStart(2, "0");
}

function safeMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function parseLooseDate(value: string): number | null {
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return safeMs(`${compact[1]}-${compact[2]}-${compact[3]}`);
  const dotted = value.match(/(\d{4})[.\-/\s]+(\d{1,2})[.\-/\s]+(\d{1,2})/);
  if (dotted) return safeMs(`${dotted[1]}-${pad(dotted[2]!)}-${pad(dotted[3]!)}`);
  return safeMs(value);
}

// RDAP(rdap.org 부트스트랩) 응답에서 등록일 이벤트를 뽑는다.
function parseRdapRegistration(body: string): number | null {
  try {
    const data = JSON.parse(body) as { events?: { eventAction?: string; eventDate?: string }[] };
    const reg = data.events?.find((event) => event.eventAction === "registration");
    return reg?.eventDate ? safeMs(reg.eventDate) : null;
  } catch {
    return null;
  }
}

// KISA WHOIS 오픈API 응답에서 등록일을 방어적으로 찾는다 (스키마가 유동적이라 키 탐색 + 원문 폴백).
function deepFindDate(node: unknown, keyRe: RegExp): number | null {
  if (node === null || typeof node !== "object") return null;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (keyRe.test(key) && typeof value === "string") {
      const ms = parseLooseDate(value);
      if (ms !== null) return ms;
    }
    if (value !== null && typeof value === "object") {
      const nested = deepFindDate(value, keyRe);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function parseKisaRegistration(body: string): number | null {
  try {
    const found = deepFindDate(JSON.parse(body), /regist|regDate|등록/i);
    if (found !== null) return found;
  } catch {
    /* JSON 아님 — 원문 폴백 */
  }
  const match = body.match(/등록\s*(?:일|날짜)?[^0-9]{0,6}(\d{4})[.\-/\s]+(\d{1,2})[.\-/\s]+(\d{1,2})/);
  if (match) return safeMs(`${match[1]}-${pad(match[2]!)}-${pad(match[3]!)}`);
  return null;
}

/** 등록 후 경과 일수. 조회 실패·타임아웃·미지원은 null (fail-open). */
async function domainAgeDays(host: string, deps: PrecheckDeps): Promise<number | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ? deps.now() : Date.now();
  const timeoutMs = deps.timeoutMs ?? 4_000;
  const registrable = registrableDomain(host);
  try {
    let registeredMs: number | null;
    if (registrable.endsWith(".kr")) {
      const key = deps.kisaWhoisKey ?? process.env.KISA_WHOIS_KEY ?? "";
      if (!key) return null; // 키 없으면 .kr 나이 검사 생략 (fail-open)
      const url = `https://whois.kisa.or.kr/openapi/whois.jsp?query=${encodeURIComponent(registrable)}&key=${encodeURIComponent(key)}&answer=json`;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      registeredMs = parseKisaRegistration(await response.text());
    } else {
      const url = `https://rdap.org/domain/${encodeURIComponent(registrable)}`;
      const response = await fetchImpl(url, {
        headers: { Accept: "application/rdap+json" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      registeredMs = parseRdapRegistration(await response.text());
    }
    if (registeredMs === null) return null;
    return Math.floor((now - registeredMs) / 86_400_000);
  } catch {
    return null;
  }
}

/**
 * 결정적 프리체크. 도메인 티어 → 위험신호 → (Tier2) 도메인 나이 → 공고 패턴 순.
 * documents 는 **마스킹 전 원문**을 넘긴다 (위험신호는 원문 대상). Solar 로는 가지 않는다.
 */
export async function precheck(
  finalUrl: string,
  documents: SourceDocument[],
  deps: PrecheckDeps = {},
): Promise<PrecheckResult> {
  const text = documents.map((document) => document.text).join("\n");
  const log = deps.onLog ?? (() => {});

  // 1. 도메인 티어
  const domain = classifyDomain(finalUrl);
  if (domain.tier === "tier3") return { verdict: "reject", tier: "tier3", reason: domain.reason };

  // 2. 위험 신호 (전 티어, 단 **랜딩 문서만** 스캔) — 첨부 신청서 양식에는 "주민등록번호
  //    수집 동의"·"지원금 입금 계좌" 기재란이 표준으로 들어가 오탐원이 된다 (100건 실측 오탐 9건).
  //    피싱의 유인 문구는 피해자가 보는 랜딩 페이지에 있으므로 랜딩 문서 스캔으로 방어 의도는 유지된다.
  const risk = scanRiskSignals(documents[0]?.text ?? "");
  if (risk) return { verdict: "reject", tier: domain.tier, reason: risk };

  // 3. Tier2 한정 도메인 나이 검사 (fail-open)
  if (domain.tier === "tier2" && !deps.skipAgeCheck) {
    const host = new URL(finalUrl).hostname.toLowerCase().replace(/\.$/, "");
    const ageDays = await domainAgeDays(host, deps);
    if (ageDays !== null && ageDays < NEW_DOMAIN_DAYS) {
      return { verdict: "reject", tier: "tier2", reason: `신생 도메인(등록 ${ageDays}일 미만 ${NEW_DOMAIN_DAYS}일) — 피싱 도메인은 대부분 단명` };
    }
    if (ageDays === null) log(`도메인 나이 조회 실패/생략 — 통과(fail-open): ${host}`);
  }

  // 4. 공고 긍정 패턴 스코어
  const score = announcementScore(text);

  // 5. 판정: Tier1 + 공고 패턴이면 Solar 판정 생략, 그 외는 Solar 판정으로 넘긴다.
  if (domain.tier === "tier1" && score >= ANNOUNCEMENT_MIN_HITS) {
    return { verdict: "pass_fast", tier: "tier1", reason: `공공 도메인 + 공고 패턴 ${score}개 충족` };
  }
  return { verdict: "needs_llm", tier: domain.tier };
}
