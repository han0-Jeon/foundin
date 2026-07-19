import type { SkippedAttachment, SourceDocument } from "../types.js";
import { decodeText, guardedFetch, type GuardedFetchOptions } from "./fetch.js";
import { extractTitle, findAttachmentLinks, htmlToText } from "./html.js";
import { pdfToText } from "./pdf.js";

const ATTACHMENT_LIMIT = 3;
const MIN_PAGE_TEXT = 80;

export interface CollectResult {
  documents: SourceDocument[];
  skipped: SkippedAttachment[];
}

function looksLikePdf(contentType: string | null, url: string, bytes: Buffer): boolean {
  if (contentType?.includes("application/pdf")) return true;
  if (/\.pdf(?:$|[?#])/i.test(url)) return true;
  return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * 공고 URL → 원문 + 첨부 텍스트.
 * HWP/HWPX 는 자동 추출 미지원 — 정직하게 skipped 로 보고하고 브리프에 "원문 확인 필요"로 노출한다.
 */
export async function collectDocuments(url: string, options: GuardedFetchOptions = {}): Promise<CollectResult> {
  const documents: SourceDocument[] = [];
  const skipped: SkippedAttachment[] = [];

  const main = await guardedFetch(url, options);

  if (looksLikePdf(main.contentType, main.finalUrl, main.bytes)) {
    const text = await pdfToText(main.bytes);
    if (text.length < MIN_PAGE_TEXT) throw new Error("PDF 에서 텍스트를 추출하지 못했습니다 (스캔본 가능성)");
    documents.push({ url: main.finalUrl, kind: "pdf", title: main.fileName, text });
    return { documents, skipped };
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
    if (link.kind === "hwp" || link.kind === "hwpx") {
      skipped.push({ url: link.url, kind: link.kind, fileName: link.label || null });
      continue;
    }
    try {
      const attachment = await guardedFetch(link.url, options);
      if (looksLikePdf(attachment.contentType, attachment.finalUrl, attachment.bytes)) {
        const text = await pdfToText(attachment.bytes);
        if (text.length >= MIN_PAGE_TEXT) {
          documents.push({
            url: attachment.finalUrl,
            kind: "pdf",
            title: attachment.fileName ?? link.label ?? null,
            text,
          });
          fetched++;
          continue;
        }
      }
      const name = (attachment.fileName ?? link.label ?? "").toLowerCase();
      if (name.endsWith(".hwp") || name.endsWith(".hwpx")) {
        skipped.push({ url: link.url, kind: name.endsWith(".hwpx") ? "hwpx" : "hwp", fileName: attachment.fileName ?? link.label });
        continue;
      }
      if (attachment.contentType?.includes("text/plain")) {
        const text = decodeText(attachment.bytes, attachment.contentType, false);
        if (text.length >= MIN_PAGE_TEXT) {
          documents.push({ url: attachment.finalUrl, kind: "text", title: attachment.fileName ?? link.label, text });
          fetched++;
        }
        continue;
      }
      // 그 외 형식은 판단 근거로 쓰지 않는다
      skipped.push({ url: link.url, kind: "unsupported", fileName: attachment.fileName ?? link.label });
    } catch {
      skipped.push({ url: link.url, kind: "fetch_failed", fileName: link.label || null });
    }
  }

  return { documents, skipped };
}
