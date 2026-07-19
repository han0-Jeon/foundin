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

export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+(?:hidden|display\s*:\s*none)[^>]*>[\s\S]*?<\/[^>]+>/gi, " ");
  const withBreaks = withoutBlocks
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/th|\/td)[^>]*>/gi, "\n")
    .replace(/<(?:li|tr)[^>]*>/gi, "\n- ");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
