import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SSRF 가드 fetch — 사용자 제출 URL 을 서버가 대신 여는 유일한 지점.
// http/https 만, 사설·루프백 대역 차단, 리다이렉트는 홉마다 재검사.

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "FoundinAgent/0.1 (+https://foundin.kr)";

export interface GuardedFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  /** 테스트용 — DNS·사설 IP 검사 생략 */
  skipGuard?: boolean;
}

export interface FetchedResource {
  finalUrl: string;
  contentType: string | null;
  fileName: string | null;
  bytes: Buffer;
}

function isPrivateIp(address: string): boolean {
  if (address === "::1" || address.toLowerCase().startsWith("fe80:") || /^f[cd]/i.test(address)) return true;
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a = 0, b = 0] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`허용되지 않는 프로토콜: ${url.protocol}`);
  }
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("내부 호스트는 접근할 수 없습니다");
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error("사설 IP 는 접근할 수 없습니다");
    return;
  }
  const resolved = await lookup(host, { all: true }).catch(() => []);
  if (resolved.length === 0) throw new Error(`DNS 조회 실패: ${host}`);
  for (const entry of resolved) {
    if (isPrivateIp(entry.address)) throw new Error("사설 대역으로 해석되는 호스트입니다");
  }
}

function fileNameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8.trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = value.match(/filename="?([^";]+)"?/i)?.[1]?.trim() ?? null;
  if (!plain) return null;
  // 한국 공공 게시판은 EUC-KR 바이트를 latin1 로 보내는 경우가 많다
  if (/[-ÿ]/.test(plain)) {
    try {
      return new TextDecoder("euc-kr", { fatal: true }).decode(Buffer.from(plain, "latin1"));
    } catch {
      return plain;
    }
  }
  return plain;
}

export async function guardedFetch(rawUrl: string, options: GuardedFetchOptions = {}): Promise<FetchedResource> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let current = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!options.skipGuard) await assertPublicHost(current);

    const response = await fetchImpl(current.toString(), {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`리다이렉트 응답에 location 없음 (HTTP ${response.status})`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error(`문서가 너무 큼: ${declared} bytes`);

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`문서가 너무 큼: ${bytes.length} bytes`);

    return {
      finalUrl: current.toString(),
      contentType: response.headers.get("content-type"),
      fileName: fileNameFromDisposition(response.headers.get("content-disposition")),
      bytes,
    };
  }
  throw new Error("리다이렉트가 너무 많습니다");
}

/** 응답 바이트를 문자셋 추정과 함께 텍스트로 디코드 (한국 공공 사이트 EUC-KR 대응) */
export function decodeText(bytes: Buffer, contentType: string | null, htmlSniff = true): string {
  const headerCharset = contentType?.match(/charset=([\w-]+)/i)?.[1]?.toLowerCase() ?? null;
  const tryDecode = (charset: string): string | null => {
    try {
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      return null;
    }
  };

  if (headerCharset && headerCharset !== "utf-8" && headerCharset !== "utf8") {
    const decoded = tryDecode(headerCharset);
    if (decoded) return decoded;
  }
  let text = tryDecode("utf-8") ?? bytes.toString("utf8");
  if (htmlSniff) {
    const metaCharset = text
      .slice(0, 2000)
      .match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]
      ?.toLowerCase();
    if (metaCharset && metaCharset !== "utf-8" && metaCharset !== "utf8") {
      const decoded = tryDecode(metaCharset);
      if (decoded) return decoded;
    }
  }
  // UTF-8 디코드가 심하게 깨졌으면 (치환문자 다수) EUC-KR 재시도
  const replacementRatio = (text.match(/�/g)?.length ?? 0) / Math.max(1, text.length);
  if (replacementRatio > 0.02) {
    const euckr = tryDecode("euc-kr");
    if (euckr && (euckr.match(/�/g)?.length ?? 0) < (text.match(/�/g)?.length ?? 0)) {
      text = euckr;
    }
  }
  return text;
}
