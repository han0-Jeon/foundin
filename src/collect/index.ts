import type { ContactInfo, SkippedAttachment, SourceDocument } from "../types.js";
import { decodeText, guardedFetch, type GuardedFetchOptions } from "./fetch.js";
import { extractContact, hasContact, maskContact } from "./contact.js";
import { extractTitle, findAttachmentLinks, htmlToText } from "./html.js";
import { docxToText, hwpToText, hwpxToText, looksLikeCfb, looksLikeZip } from "./hwp.js";
import { pdfToText } from "./pdf.js";

const ATTACHMENT_LIMIT = 3;
const MIN_PAGE_TEXT = 80;
const MIN_ATTACHMENT_TEXT = 40;
// K-Startup 셸 페이지(빈 상세, 브레드크럼만 ~92자) 감지 임계 — 실제 상세는 수천 자
const KSTARTUP_SHELL_TEXT = 300;

export interface CollectResult {
  /** Solar 로 보낼 문서 — 연락처가 마스킹된 상태 */
  documents: SourceDocument[];
  /** 마스킹 전 원문 — 로컬 프리체크(위험신호 스캔) 전용. LLM 으로 절대 보내지 않는다. */
  rawDocuments: SourceDocument[];
  skipped: SkippedAttachment[];
  /** 원문에서 뽑은 담당자 연락처 (마스킹 전, 표시 전용) */
  contact: ContactInfo | null;
}

/**
 * K-Startup 상세는 모집 상태에 따라 경로가 갈린다: 모집중=bizpbanc-ongoing.do,
 * 마감=bizpbanc-deadline.do. 반대 경로로 접근하면 본문 없는 셸만 서빙되므로
 * (마감된 공고를 ongoing 링크로 여는 경우가 대표적) 형제 경로를 폴백으로 시도한다.
 */
export function kstartupSiblingUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "k-startup.go.kr" && !host.endsWith(".k-startup.go.kr")) return null;
  const match = url.pathname.match(/^(.*\/bizpbanc-)(ongoing|deadline)(\.do)$/);
  if (!match || !url.searchParams.get("pbancSn")) return null;
  url.pathname = `${match[1]}${match[2] === "ongoing" ? "deadline" : "ongoing"}${match[3]}`;
  return url.toString();
}

/** 원문에서 연락처를 뽑고(표시용), 문서 텍스트는 마스킹(Solar 전송용)해서 돌려준다. */
function redactDocuments(documents: SourceDocument[]): {
  masked: SourceDocument[];
  raw: SourceDocument[];
  contact: ContactInfo | null;
} {
  const contact = extractContact(documents.map((document) => document.text).join("\n"));
  const masked = documents.map((document) => ({ ...document, text: maskContact(document.text) }));
  return { masked, raw: documents, contact: hasContact(contact) ? contact : null };
}

function looksLikePdf(contentType: string | null, url: string, bytes: Buffer): boolean {
  if (contentType?.includes("application/pdf")) return true;
  if (/\.pdf(?:$|[?#])/i.test(url)) return true;
  return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

interface ExtractedFile {
  kind: SourceDocument["kind"];
  text: string;
}

/** 바이트 시그니처·파일명으로 포맷을 판별해 텍스트 추출. 실패는 사유가 담긴 Error 로 던진다. */
async function extractFile(bytes: Buffer, url: string, contentType: string | null, fileName: string | null): Promise<ExtractedFile> {
  const name = (fileName ?? url).toLowerCase();

  if (looksLikePdf(contentType, url, bytes)) {
    return { kind: "pdf", text: await pdfToText(bytes) };
  }
  if (looksLikeCfb(bytes)) {
    return { kind: "hwp", text: hwpToText(bytes) };
  }
  if (looksLikeZip(bytes)) {
    // ZIP 컨테이너 3종 분기: DOCX / HWPX / (미지원 zip·xlsx·pptx)
    if (name.match(/\.docx(?:$|[?#])/) || contentType?.includes("wordprocessingml")) {
      return { kind: "docx", text: docxToText(bytes) };
    }
    if (name.endsWith(".hwpx") || !name.match(/\.(zip|xlsx|pptx)(?:$|[?#])/)) {
      // 확장자 없는 다운로드 링크 대응: HWPX 시도 → 섹션 없으면 DOCX 폴백
      try {
        return { kind: "hwpx", text: hwpxToText(bytes) };
      } catch (hwpxError) {
        try {
          return { kind: "docx", text: docxToText(bytes) };
        } catch {
          throw hwpxError; // 원 사유(HWPX 섹션 없음)가 더 정보적
        }
      }
    }
  }
  if (contentType?.includes("text/plain") || name.endsWith(".txt")) {
    return { kind: "text", text: decodeText(bytes, contentType, false) };
  }
  throw new Error("지원하지 않는 파일 형식");
}

/**
 * 공고 URL → 원문 + 첨부 텍스트 (HTML·PDF·HWP·HWPX·TXT).
 * 암호화 HWP 등 읽지 못한 첨부는 skipped 로 보고하고 브리프에 "원문 확인 필요"로 노출한다.
 */
export async function collectDocuments(url: string, options: GuardedFetchOptions = {}): Promise<CollectResult> {
  const documents: SourceDocument[] = [];
  const skipped: SkippedAttachment[] = [];

  let main = await guardedFetch(url, options);

  // 메인 URL 이 문서 파일 직링크인 경우
  if (looksLikePdf(main.contentType, main.finalUrl, main.bytes) || looksLikeCfb(main.bytes)) {
    const extracted = await extractFile(main.bytes, main.finalUrl, main.contentType, main.fileName);
    if (extracted.text.length < MIN_PAGE_TEXT) {
      throw new Error(`${extracted.kind.toUpperCase()} 에서 텍스트를 추출하지 못했습니다 (스캔본 가능성)`);
    }
    documents.push({ url: main.finalUrl, kind: extracted.kind, title: main.fileName, text: extracted.text });
    const single = redactDocuments(documents);
    return { documents: single.masked, rawDocuments: single.raw, skipped, contact: single.contact };
  }

  let html = decodeText(main.bytes, main.contentType);
  let pageText = htmlToText(html);

  // K-Startup 셸 폴백: 본문이 임계 미만이면 형제 경로(ongoing↔deadline)를 시도해 더 긴 쪽을 쓴다.
  if (pageText.length < KSTARTUP_SHELL_TEXT) {
    const sibling = kstartupSiblingUrl(main.finalUrl) ?? kstartupSiblingUrl(url);
    if (sibling) {
      try {
        const alt = await guardedFetch(sibling, options);
        const altHtml = decodeText(alt.bytes, alt.contentType);
        const altText = htmlToText(altHtml);
        if (altText.length > pageText.length) {
          main = alt;
          html = altHtml;
          pageText = altText;
        }
      } catch {
        // 형제 경로 실패는 무시 — 원본 판정 그대로 진행
      }
    }
  }

  if (pageText.length < MIN_PAGE_TEXT) {
    throw new Error("페이지에서 본문 텍스트를 찾지 못했습니다 (JS 렌더링 페이지 가능성)");
  }
  documents.push({ url: main.finalUrl, kind: "html", title: extractTitle(html), text: pageText });

  let fetched = 0;
  for (const link of findAttachmentLinks(html, main.finalUrl)) {
    if (fetched >= ATTACHMENT_LIMIT) break;
    let attachment;
    try {
      attachment = await guardedFetch(link.url, options);
    } catch {
      skipped.push({ url: link.url, kind: "다운로드 실패", fileName: link.label || null });
      continue;
    }
    const fileName = attachment.fileName ?? link.label ?? null;
    try {
      const extracted = await extractFile(attachment.bytes, attachment.finalUrl, attachment.contentType, fileName);
      if (extracted.text.length < MIN_ATTACHMENT_TEXT) {
        skipped.push({ url: link.url, kind: `${extracted.kind} 텍스트 없음`, fileName });
        continue;
      }
      documents.push({ url: attachment.finalUrl, kind: extracted.kind, title: fileName, text: extracted.text });
      fetched++;
    } catch (error) {
      skipped.push({
        url: link.url,
        kind: error instanceof Error ? error.message.slice(0, 60) : "추출 실패",
        fileName,
      });
    }
  }

  const { masked, raw, contact } = redactDocuments(documents);
  return { documents: masked, rawDocuments: raw, skipped, contact };
}
