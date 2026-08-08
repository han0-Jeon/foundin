// HTML → 본문 텍스트 + 첨부 링크 탐색. 외부 파서 없이 정규식 기반 (수집 대상이 게시판형 정적 페이지라 충분).

export interface AttachmentLink {
  url: string;
  label: string;
  kind: "pdf" | "hwp" | "hwpx" | "txt" | "unknown";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  middot: "·", ndash: "-", mdash: "-", hellip: "…", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', times: "×", pound: "£", won: "₩",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

// ── 본문 추출 ───────────────────────────────────────────────────────────
// 게시판형 공고 페이지의 병 두 가지: (1) 사이트 메뉴가 본문보다 길고, (2) 표·라벨쌍이
// 마크업 구조로만 표현돼 셀마다 개행이 되면 "지원분야 / 사업화" 가 두 줄로 흩어진다.
// → 메뉴를 걷어내고 본문 영역만 고른 뒤, 셀 경계를 " | " 로 이어 한 줄에 라벨과 값이 같이 남게 한다.
//
// ⚠ 웹 repo 의 lib/program-documents/extract.ts 와 **같은 규칙**이어야 한다. 브리프 인용문은 워커의 추출 결과에서
//   나오고, 근거 뷰어는 그 인용을 웹이 저장한 텍스트에서 찾는다 — 두 추출기가 갈라지면
//   "위치 못 찾음"이 대량 발생한다. 규칙을 바꿀 땐 반드시 양쪽을 함께 고친다.
//   (설계: foundin.kr repo docs/superpowers/specs/2026-08-08-source-extraction-design.md)

const TEXT_LIMIT = 200_000;
const CELL = "\u0001"; // 셀 경계 — 마지막에 " | " 로 치환
const BREAK = "\u0002"; // 태그가 만든 줄바꿈 — 원문에 원래 있던 공백·개행과 구별한다
const SEPARATOR = " | ";
// 본문 컨테이너 후보 — 구체적인 것부터. 게시판 본문 class 는 <main> 보다 정확하다
// (mss 는 좌측 메뉴까지 <main> 안에 넣는다 — 실측 2026-08-08).
const BOARD_BODY_HINT = /(board_view|bbs_?view|board_?body|view_cont|view_contents)/i;
/** 넓은 래퍼 — <main>·<article> 이 없는 사이트의 마지막 후보 (k-startup 은 content_wrap) */
const WRAPPER_HINT = /(contents?_wrap|contents_inner|sub_?content|content_area|contentViewHtml)/i;
/** 이 길이를 넘겨야 "본문을 찾았다"고 인정한다 — 미달이면 다음 후보로, 끝내 없으면 문서 전체 */
const MIN_BODY_TEXT = 400;
const MAX_DIV_CANDIDATES = 4;

const BLOCK_TAGS = new Set([
  "p", "div", "li", "ul", "ol", "dl", "dt", "dd", "tr", "table", "thead", "tbody", "tfoot",
  "caption", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "aside", "header",
  "footer", "nav", "main", "blockquote", "pre", "form", "fieldset", "legend", "address",
  "figure", "figcaption", "hr", "details", "summary", "option",
]);
const CELL_TAGS = new Set(["td", "th"]);
const ROW_RESET_TAGS = new Set(["tr", "table", "thead", "tbody", "tfoot"]);

// 태그의 속성부. 따옴표 안의 ">" 를 태그 끝으로 오해하지 않는다 —
// onclick="f('제목');" 같은 속성 때문에 `모집중">` 이 본문에 새던 잡음의 원인이었다.
// 따옴표 안에 "<" 는 허용하지 않아, 닫는 따옴표가 없는 깨진 마크업에서도 다음 태그를 넘지 않는다.
const ATTRS_SOURCE = `(?:"[^"<]*"|'[^'<]*'|[^>"'<])*`;

/** 속성 문자열의 class 에 해당 토큰이 그대로 있는지 (board_tit 같은 유사 클래스는 제외) */
function hasClassWord(attrs: string, word: string): boolean {
  const found = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const value = found?.[1] ?? found?.[2] ?? found?.[3] ?? "";
  return value.split(/\s+/).some((token) => token.toLowerCase() === word);
}

function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+(?:hidden|display\s*:\s*none)[^>]*>[\s\S]*?<\/[^>]+>/gi, " ")
    .replace(/<![^>]*>/g, " ")
    .replace(/<\?[\s\S]*?\?>/g, " ");
}

/** <main>·<article> 안쪽 — 마지막 닫는 태그까지 (중첩돼 있어도 바깥쪽을 온전히 담는다) */
function tagSlice(html: string, tag: string): string | null {
  const open = new RegExp(`<${tag}\\b${ATTRS_SOURCE}>`, "i").exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const end = html.toLowerCase().lastIndexOf(`</${tag}>`);
  return end > start ? html.slice(start, end) : null;
}

/** 여는 div 의 짝을 깊이로 세어 안쪽을 잘라낸다 (정규식으로는 중첩을 못 센다) */
function balancedDivSlice(html: string, from: number): string | null {
  const tagPattern = new RegExp(`<(/?)div\\b${ATTRS_SOURCE}>`, "gi");
  tagPattern.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(from, match.index);
  }
  return null;
}

function hintedDivSlices(html: string, hint: RegExp, limit: number): string[] {
  const slices: string[] = [];
  const openPattern = new RegExp(`<div\\b(${ATTRS_SOURCE})>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = openPattern.exec(html)) !== null && slices.length < limit) {
    if (!hint.test(match[1] ?? "")) continue;
    const slice = balancedDivSlice(html, match.index + match[0].length);
    if (slice) slices.push(slice);
  }
  return slices;
}

/** 구체적인 후보부터 — 게시판 본문 class → <main>/<article> → 넓은 래퍼 → (호출부에서) 문서 전체 */
function bodyCandidates(html: string): string[] {
  const candidates = hintedDivSlices(html, BOARD_BODY_HINT, MAX_DIV_CANDIDATES);
  const main = tagSlice(html, "main");
  if (main) candidates.push(main);
  const article = tagSlice(html, "article");
  if (article) candidates.push(article);
  candidates.push(...hintedDivSlices(html, WRAPPER_HINT, MAX_DIV_CANDIDATES));
  return candidates;
}

/** 한 줄 정리 — 공백 압축 + 구분자 정규화 + 빈 셀 접기 + 줄 양끝 잔여 구분자 제거 */
function tidyLine(line: string): string {
  return line
    .replace(/[ \t\f\v\u00a0\u3000]+/g, " ")
    .replace(/(?: *\| *)+/g, SEPARATOR)
    .replace(/^\s*\|\s*/, "")
    .replace(/\s*\|\s*$/, "")
    .trim();
}

/**
 * 태그를 훑어 줄을 조립한다. 셀 경계는 CELL, 태그가 만든 줄바꿈은 BREAK 로 표시해 두고
 * 마지막에 한 번에 해석한다 — 원문에 원래 있던 개행과 섞이면 라벨/값이 다시 갈라진다.
 */
function renderText(html: string): string {
  const out: string[] = [];
  // 라벨/값 쌍: 라벨을 닫는 순간 셀 경계를 임시로 두고, 바로 뒤에 값 요소가 오면 확정한다.
  // 값이 안 오면 그 자리를 줄바꿈으로 되돌린다 (= 종전 동작).
  let pendingAt = -1;
  let pendingKind: "txt" | "dd" | null = null;
  let pendingHops = 0;
  let titTag: string | null = null;
  let cellIndex = 0; // 현재 행에서 몇 번째 셀인가 — 구분자는 셀 "앞"에 놓는다 (행 끝 잔여물 방지)

  const cancelPending = (): void => {
    if (pendingAt >= 0) out[pendingAt] = BREAK;
    pendingAt = -1;
    pendingKind = null;
  };
  const openPending = (kind: "txt" | "dd"): void => {
    out.push(CELL);
    pendingAt = out.length - 1;
    pendingKind = kind;
    pendingHops = 0;
  };

  const tagPattern = new RegExp(`<(/?)([a-zA-Z][a-zA-Z0-9]*)\\b(${ATTRS_SOURCE})>`, "g");
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    const between = html.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (between) {
      out.push(between);
      if (between.trim()) cancelPending();
    }

    const closing = match[1] === "/";
    const name = (match[2] ?? "").toLowerCase();
    const attrs = match[3] ?? "";

    // 대기 중인 라벨의 짝인가 — 짝이면 이 태그의 줄바꿈을 건너뛰어 한 줄로 잇는다.
    if (pendingAt >= 0 && !closing) {
      const isValue = pendingKind === "txt" ? hasClassWord(attrs, "txt") : name === "dd";
      if (isValue) {
        pendingAt = -1;
        pendingKind = null;
        continue;
      }
      if (++pendingHops > 2) cancelPending();
    }

    if (ROW_RESET_TAGS.has(name)) cellIndex = 0;

    if (name === "br") {
      cancelPending();
      out.push(BREAK);
      continue;
    }
    if (CELL_TAGS.has(name)) {
      if (!closing) {
        cancelPending();
        if (cellIndex > 0) out.push(CELL);
        cellIndex += 1;
      }
      continue;
    }
    if (name === "dt" && closing) {
      openPending("dd");
      continue;
    }
    if (!closing && hasClassWord(attrs, "tit")) {
      cancelPending();
      out.push(BREAK);
      titTag = name;
      continue;
    }
    if (closing && titTag === name) {
      titTag = null;
      openPending("txt");
      continue;
    }
    if (BLOCK_TAGS.has(name)) {
      cancelPending();
      out.push(BREAK);
      continue;
    }
    out.push(" ");
  }
  out.push(html.slice(cursor));

  const decoded = decodeEntities(out.join(""))
    // 셀 경계 주변의 원문 공백·개행은 흡수한다 (BREAK 는 공백이 아니라 살아남는다)
    .replace(/\s*\u0001\s*/g, CELL)
    // 줄바꿈 직전에 남은 구분자는 값이 빈 셀 — 버린다
    .replace(/\u0001+(?=\u0002)/g, "")
    .split(CELL)
    .join(SEPARATOR)
    .split(BREAK)
    .join("\n");
  return decoded
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(tidyLine)
    .filter(Boolean)
    .join("\n")
    .slice(0, TEXT_LIMIT)
    .trim();
}

export function htmlToText(html: string): string {
  const cleaned = stripNoise(html);
  for (const candidate of bodyCandidates(cleaned)) {
    const text = renderText(candidate);
    if (text.length >= MIN_BODY_TEXT) return text;
  }
  return renderText(cleaned);
}

export function extractTitle(html: string): string | null {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const title = og ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null;
  return title ? decodeEntities(title).replace(/\s+/g, " ").trim().slice(0, 200) || null : null;
}

function kindFromText(value: string): AttachmentLink["kind"] {
  const ext = value.toLowerCase().match(/\.(pdf|hwpx|hwp|txt)(?:$|[?#"'\s])/)?.[1];
  if (ext === "pdf") return "pdf";
  if (ext === "hwpx") return "hwpx";
  if (ext === "hwp") return "hwp";
  if (ext === "txt") return "txt";
  return "unknown";
}

/** 첨부로 보이는 앵커 수집 — 확장자 또는 다운로드 엔드포인트 + 라벨 확장자 */
export function findAttachmentLinks(html: string, baseUrl: string): AttachmentLink[] {
  const links: AttachmentLink[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const rawHref = (match[2] ?? match[3] ?? "").trim();
    if (!rawHref || rawHref.startsWith("#") || /^(?:javascript|mailto|tel):/i.test(rawHref)) continue;
    let url: string;
    try {
      url = new URL(decodeEntities(rawHref), baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;

    const label = decodeEntities((match[4] ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    let kind = kindFromText(url);
    if (kind === "unknown") kind = kindFromText(label);
    const isDownloadEndpoint = /(?:download|atchFile|fileDown|getFile|fileId=)/i.test(url);
    if (kind === "unknown" && !isDownloadEndpoint) continue;

    seen.add(url);
    links.push({ url, label: label.slice(0, 120), kind });
    if (links.length >= 10) break;
  }
  return links;
}

// ── 인라인 포스터 이미지 후보 (OCR 용) ────────────────────────
// 본문 텍스트가 빈약한 공고는 카드뉴스형 포스터 <img> 하나가 본문인 경우가 많다.
// 아이콘·로고·버튼류는 파일명 휴리스틱으로 걸러낸다.
const IMAGE_SKIP_NAME = /(logo|icon|ico_|btn|button|banner|bullet|blank|spacer|arrow|dot_|bg_|_bg)/i;

export function findInlineImages(html: string, baseUrl: string, limit = 3): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const imgPattern = /<img\b[^>]*src\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgPattern.exec(html)) !== null && urls.length < limit) {
    const rawSrc = (match[2] ?? match[3] ?? "").trim();
    if (!rawSrc || rawSrc.startsWith("data:")) continue;
    let url: string;
    try {
      url = new URL(decodeEntities(rawSrc), baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    if (!/\.(png|jpe?g)(?:$|[?#])/i.test(url) && !/(?:imgFile|fileDown|getImage|thumbnail)/i.test(url)) continue;
    if (IMAGE_SKIP_NAME.test(url)) continue;
    urls.push(url);
  }
  return urls;
}
