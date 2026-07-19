import type { ContactInfo, SkippedAttachment, SourceDocument } from "../types.js";
import { decodeText, guardedFetch, type GuardedFetchOptions } from "./fetch.js";
import { extractContact, hasContact, maskContact } from "./contact.js";
import { extractTitle, findAttachmentLinks, htmlToText } from "./html.js";
import { hwpToText, hwpxToText, looksLikeCfb, looksLikeZip } from "./hwp.js";
import { pdfToText } from "./pdf.js";

const ATTACHMENT_LIMIT = 3;
const MIN_PAGE_TEXT = 80;
const MIN_ATTACHMENT_TEXT = 40;

export interface CollectResult {
  /** Solar 로 보낼 문서 — 연락처가 마스킹된 상태 */
  documents: SourceDocument[];
  /** 마스킹 전 원문 — 로컬 프리체크(위험신호 스캔) 전용. LLM 으로 절대 보내지 않는다. */
  rawDocuments: SourceDocument[];
  skipped: SkippedAttachment[];
  /** 원문에서 뽑은 담당자 연락처 (마스킹 전, 표시 전용) */
  contact: ContactInfo | null;
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
  if (looksLikeZip(bytes) && (name.endsWith(".hwpx") || !name.match(/\.(zip|docx|xlsx|pptx)(?:$|[?#])/))) {
    // HWPX 는 ZIP 컨테이너 — 섹션 XML 이 없으면 hwpxToText 가 사유와 함께 던진다
    return { kind: "hwpx", text: hwpxToText(bytes) };
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

  const main = await guardedFetch(url, options);

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

  const html = decodeText(main.bytes, main.contentType);
  const pageText = htmlToText(html);
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
