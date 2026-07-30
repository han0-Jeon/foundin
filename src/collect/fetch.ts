import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

// SSRF 가능한 fetch — 사용자 제출 URL 을 서버가 대신 여는 유일한 지점.
// 각 리다이렉트 홉의 DNS 결과를 검증한 뒤 그 IP를 실제 소켓 lookup에 고정한다.

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "FoundinAgent/0.1 (+https://foundin.kr)";

export interface GuardedFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  /** 테스트용 — DNS·사설 IP 검사를 생략한다. 사용자 입력 경로에서는 사용하지 않는다. */
  skipGuard?: boolean;
  /** UA 오버라이드 — 배포 도구(MCP·CLI)의 프로덕션 호출과 평가를 분리한다 */
  userAgent?: string;
}

export interface FetchedResource {
  finalUrl: string;
  contentType: string | null;
  fileName: string | null;
  bytes: Buffer;
}

export interface PinnedTarget {
  address: string;
  family: 4 | 6;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isPrivateIp(address: string): boolean {
  const normalized = normalizeHostname(address);
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateIp(mapped);

  if (isIP(normalized) === 6) {
    return (
      normalized.startsWith("::") ||
      /^f[cd]/i.test(normalized) ||
      /^fe[89ab]/i.test(normalized) ||
      /^fe[c-f]/i.test(normalized) ||
      /^ff/i.test(normalized) ||
      /^64:ff9b:/i.test(normalized) ||
      /^2001:db8:/i.test(normalized) ||
      /^2002:/i.test(normalized)
    );
  }

  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

async function resolvePublicTarget(url: URL): Promise<PinnedTarget> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`허용되지 않는 프로토콜: ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error("인증 정보가 포함된 URL은 허용되지 않습니다");

  const host = normalizeHostname(url.hostname);
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("내부 호스트는 접근할 수 없습니다");
  }
  const literalFamily = isIP(host);
  if (literalFamily) {
    if (isPrivateIp(host)) throw new Error("사설 또는 비공개 IP는 접근할 수 없습니다");
    return { address: host, family: literalFamily as 4 | 6 };
  }

  const resolved = await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (resolved.length === 0) throw new Error(`DNS 조회 실패: ${host}`);
  if (resolved.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("사설 대역으로 해석되는 호스트입니다");
  }
  const selected = resolved.find((entry) => entry.family === 4) ?? resolved[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

/** 검증한 주소를 실제 TCP 연결에서도 그대로 사용해 DNS rebinding을 막는다. */
export function createPinnedLookup(target: PinnedTarget): LookupFunction {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value === undefined ? null : String(value);
}

interface PinnedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  bytes: Buffer;
}

function requestPinned(url: URL, target: PinnedTarget, timeoutMs: number, maxBytes: number, userAgent: string): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
    const host = normalizeHostname(url.hostname);
    const req = requestImpl(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { "User-Agent": userAgent, Accept: "*/*", "Accept-Encoding": "identity" },
        lookup: createPinnedLookup(target),
        signal: AbortSignal.timeout(timeoutMs),
        ...(url.protocol === "https:" ? { servername: host } : {}),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const finish = (bytes: Buffer) => {
          if (settled) return;
          settled = true;
          resolve({ status, headers: response.headers, bytes });
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          response.destroy();
          reject(error);
        };

        const declared = Number(headerValue(response.headers, "content-length") ?? 0);
        if (Number.isFinite(declared) && declared > maxBytes) {
          fail(new Error(`문서가 너무 큼: ${declared} bytes`));
          return;
        }
        if ((status >= 300 && status < 400) || status < 200 || status >= 300) {
          response.destroy();
          finish(Buffer.alloc(0));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | Uint8Array) => {
          total += chunk.length;
          if (total > maxBytes) {
            fail(new Error(`문서가 너무 큼: ${total} bytes`));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => finish(Buffer.concat(chunks, total)));
        response.on("error", fail);
      },
    );
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.end();
  });
}

async function readLimitedFetchBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`문서가 너무 큼: ${declared} bytes`);
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`문서가 너무 큼: ${total} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
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
  // 한국 공공 게시판은 EUC-KR 바이트를 latin1 로 보내는 경우가 많다.
  if (/[\u0080-\u00ff]/.test(plain)) {
    try {
      return new TextDecoder("euc-kr", { fatal: true }).decode(Buffer.from(plain, "latin1"));
    } catch {
      return plain;
    }
  }
  return plain;
}

/** 공공 API가 주는 원문 링크의 흔한 오류를 보정한다. */
export function normalizeRawUrl(rawUrl: string): string {
  let url = rawUrl.trim().replace(/&amp;/g, "&");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]|$)/i.test(url)) {
    url = `https://${url}`;
  }
  return url;
}

export async function guardedFetch(rawUrl: string, options: GuardedFetchOptions = {}): Promise<FetchedResource> {
  if (options.fetchImpl && !options.skipGuard) {
    throw new Error("사용자 정의 fetch는 skipGuard 테스트 경로에서만 허용됩니다");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = options.userAgent ?? USER_AGENT;

  let current = new URL(normalizeRawUrl(rawUrl));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let status: number;
    let getHeader: (name: string) => string | null;
    let bytes: Buffer;

    if (options.skipGuard) {
      const response = await (options.fetchImpl ?? fetch)(current.toString(), {
        redirect: "manual",
        headers: { "User-Agent": userAgent, Accept: "*/*", "Accept-Encoding": "identity" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      getHeader = (name) => response.headers.get(name);
      if (status >= 300 && status < 400) {
        await response.body?.cancel();
        const location = getHeader("location");
        if (!location) throw new Error(`리다이렉트 응답에 location 없음 (HTTP ${status})`);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${status}`);
      }
      bytes = await readLimitedFetchBody(response, maxBytes);
    } else {
      const target = await resolvePublicTarget(current);
      const response = await requestPinned(current, target, timeoutMs, maxBytes, userAgent);
      status = response.status;
      getHeader = (name) => headerValue(response.headers, name);
      if (status >= 300 && status < 400) {
        const location = getHeader("location");
        if (!location) throw new Error(`리다이렉트 응답에 location 없음 (HTTP ${status})`);
        current = new URL(location, current);
        continue;
      }
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
      bytes = response.bytes;
    }

    return {
      finalUrl: current.toString(),
      contentType: getHeader("content-type"),
      fileName: fileNameFromDisposition(getHeader("content-disposition")),
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
