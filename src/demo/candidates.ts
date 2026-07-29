// 데모용 공고 후보 뽑기.
//
// 왜 이렇게 하나: 데모에 URL 을 하드코딩하면 (1) 공고가 마감돼 내려가면 데모가 죽고
// (2) 매번 같은 공고라 캐시에 걸려 파이프라인이 안 돈다. 그래서 실제로 지금 올라와 있는
// 공고 중에서 무작위로 뽑는다.
//
// 출처는 foundin.kr 의 공개 사이트맵이다. 별도 API 키나 자격증명이 필요 없어서
// 저장소를 클론한 누구나 그대로 돌릴 수 있다. (K-Startup 목록 페이지는 JS 렌더링이라
// 서버에서 파싱되지 않는다 — 실측 확인.)

const SITEMAP_URL = "https://foundin.kr/sitemap.xml";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * 데모 후보로 쓸 소스 호스트.
 *
 * 온통청년(youthcenter.go.kr)을 뺀 이유: 그 페이지는 공고문이 아니라 청년정책 DB 항목이라
 * 신청 자격이 서술 구조로 안 적혀 있다. foundin.kr 이 이 소스로 브리프를 만들 때는 웹앱이
 * API 필드로 원문을 합성해 넣는데, CLI 로 원본 URL 을 직접 분석하면 그 합성 단계가 없다.
 * 같은 작업이 아니라서 데모로 쓰면 8분 기다린 끝에 보류로 끝난다 (실측).
 *
 * 프로덕션 근거 (2026-07-29): '자격 요건을 하나도 추출하지 못함' 보류 41건 중
 * youth_policy 가 31건. kstartup 2 · mss 5 · sbiz24 3.
 *
 * sbiz24 는 해시 라우트 SPA 라 원본 URL 수집이 불안정해 함께 제외한다.
 */
const DEMO_SOURCE_HOSTS = ["k-startup.go.kr", "mss.go.kr", "bizinfo.go.kr"];

export function isDemoFriendly(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return DEMO_SOURCE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export interface Candidate {
  /** 공고 제목 */
  title: string;
  /** 분석 대상 원문 URL (정부 포털) */
  url: string;
  /** 한 줄 설명 — 이 후보를 고르면 무엇을 보게 되는지 */
  note: string;
}

/**
 * 공고가 아닌 페이지 표본.
 *
 * 데모의 절반은 "안 되는 걸 안 된다고 하는가" 를 보여주는 데 쓴다. 이 파이프라인의 요점은
 * 잘 요약하는 게 아니라 지어내지 않는 것이라서, 판정 단계가 포털 메인·목록 페이지를
 * 반려하는 장면이 발행된 브리프보다 오히려 더 중요한 증거다.
 *
 * 개별 공고와 달리 포털의 목록·메인 페이지는 URL 이 바뀌지 않으므로 동봉해도 썩지 않는다.
 */
const NON_ANNOUNCEMENT_SAMPLES: Candidate[] = [
  {
    title: "K-Startup 사업공고 목록",
    url: "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do",
    note: "개별 공고가 아니라 목록 페이지 — 반려되는 게 정상입니다",
  },
  {
    title: "기업마당 메인",
    url: "https://www.bizinfo.go.kr/",
    note: "포털 메인 — 반려되는 게 정상입니다",
  },
  {
    title: "온통청년 메인",
    url: "https://www.youthcenter.go.kr/main.do",
    note: "포털 메인 — 반려되는 게 정상입니다",
  },
];

/** 공고가 아닌 표본 하나를 무작위로 고른다. */
export function pickNonAnnouncement(rng: () => number = Math.random): Candidate {
  return shuffle(NON_ANNOUNCEMENT_SAMPLES, rng)[0]!;
}

async function getText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "foundin-demo (+https://github.com/han0-Jeon/foundin)" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 사이트맵에서 공고 상세 URL 만 추린다 (소스별·분야별 목록 페이지는 제외). */
export function parseSitemap(xml: string): string[] {
  const urls: string[] = [];
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const loc = m[1]!.trim();
    if (!loc.includes("/programs/")) continue;
    if (loc.includes("/programs/source/") || loc.includes("/programs/category/")) continue;
    urls.push(loc);
  }
  return urls;
}

/** 상세 페이지 HTML 에서 원문(정부 포털) URL 을 찾는다. 쿼리가 붙은 가장 구체적인 링크를 고른다. */
export function extractSourceUrl(html: string): string | null {
  const seen = new Set<string>();
  for (const m of html.matchAll(/https?:\/\/[^"'\\<>\s]{20,300}/g)) {
    const url = m[0].replace(/&amp;/g, "&");
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (host.endsWith("foundin.kr")) continue;
    // 공고 원문은 한국 공공·기관 도메인이다. 문의 폼(forms.gle) 같은 건 걸러진다.
    if (!/\.kr$/.test(host)) continue;
    seen.add(url);
  }
  // 쿼리스트링이 있는 쪽이 목록이 아니라 상세다. 그중 가장 긴 것.
  const ranked = [...seen].sort((a, b) => {
    const qa = a.includes("?") ? 1 : 0;
    const qb = b.includes("?") ? 1 : 0;
    if (qa !== qb) return qb - qa;
    return b.length - a.length;
  });
  return ranked[0] ?? null;
}

/** 상세 페이지 <title> 에서 공고명을 뽑는다. 실패하면 slug 에서 유추한다. */
export function extractTitle(html: string, pageUrl: string): string {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (m) {
    const raw = m[1]!.replace(/&amp;/g, "&").replace(/&#\d+;/g, "").trim();
    // "제목 | Foundin" 형태에서 사이트명을 떼어낸다
    const title = raw.split(/\s*[|·]\s*(?:Foundin|foundin)/)[0]!.trim();
    if (title) return title;
  }
  return titleFromSlug(pageUrl);
}

/** slug 는 `{제목-kebab}-{32hex}` 형식이다. 뒤 hex 를 떼고 하이픈을 공백으로. */
export function titleFromSlug(pageUrl: string): string {
  try {
    const last = decodeURIComponent(new URL(pageUrl).pathname.split("/").pop() ?? "");
    return last.replace(/-[0-9a-f]{32}$/i, "").replace(/-/g, " ").trim() || "(제목 없음)";
  } catch {
    return "(제목 없음)";
  }
}

/** Fisher-Yates. 테스트에서 난수를 주입할 수 있게 rng 를 받는다. */
export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * 지금 foundin.kr 에 올라와 있는 공고 중 무작위로 count 건을 뽑는다.
 * 네트워크가 막혔거나 형식이 바뀌면 빈 배열을 돌려준다 (호출 측에서 폴백).
 */
export async function fetchCandidates(count: number, rng: () => number = Math.random): Promise<Candidate[]> {
  const xml = await getText(SITEMAP_URL);
  if (!xml) return [];
  const pages = shuffle(parseSitemap(xml), rng);
  if (pages.length === 0) return [];

  const picked: Candidate[] = [];
  // 원문 링크 추출 실패 + 소스 필터(DEMO_SOURCE_HOSTS)로 걸러지는 건이 있어 여유 있게 시도한다.
  for (const page of pages.slice(0, count * 12)) {
    if (picked.length >= count) break;
    const html = await getText(page);
    if (!html) continue;
    const url = extractSourceUrl(html);
    if (!url) continue;
    if (!isDemoFriendly(url)) continue;
    if (picked.some((c) => c.url === url)) continue;
    picked.push({
      title: extractTitle(html, page),
      url,
      note: "지금 접수 중인 실제 공고 — 정독하고 브리프를 만듭니다",
    });
  }
  return picked;
}
