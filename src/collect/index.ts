import type { ContactInfo, PresetDocument, SkippedAttachment, SourceDocument } from "../types.js";
import { decodeText, guardedFetch, type GuardedFetchOptions } from "./fetch.js";
import { extractContact, hasContact, maskContact } from "./contact.js";
import { extractTitle, findAttachmentLinks, findInlineImages, htmlToText } from "./html.js";
import { docxToText, hwpToText, hwpxToText, looksLikeCfb, looksLikeZip } from "./hwp.js";
import { imageToText, ocrEnabled, type OcrDeps } from "./ocr.js";
import { pdfToText } from "./pdf.js";

const ATTACHMENT_LIMIT = 3;
const MIN_PAGE_TEXT = 80;
const MIN_ATTACHMENT_TEXT = 40;
// K-Startup 셸 페이지(빈 상세, 브레드크럼만 ~92자) 감지 임계 — 실제 상세는 수천 자
const KSTARTUP_SHELL_TEXT = 300;
// 본문+첨부 합산 텍스트가 이보다 얇으면 "포스터가 본문"일 가능성 — 인라인 이미지 OCR 시도 (옵트인)
const INLINE_OCR_TEXT = 400;
const INLINE_OCR_LIMIT = 2;

/** 수집 옵션 — fetch 가드 + (옵트인) 이미지 OCR */
export interface CollectOptions extends GuardedFetchOptions {
  /** 이미지 포스터 OCR. 미지정 시 env(FOUNDIN_OCR=docparse) 기준 */
  ocr?: OcrDeps & { enabled?: boolean };
  /**
   * 서버(claim)가 동봉한 사전 수집 문서 — 사이트 program_documents 캐시.
   * 자체 수집이 놓친 첨부를 보충하고, 본문이 얇아도 프리셋이 있으면 수집 실패로 던지지 않는다.
   */
  presetDocuments?: PresetDocument[];
}

function looksLikeImage(contentType: string | null, url: string, bytes: Buffer): boolean {
  if (contentType?.startsWith("image/")) return true;
  if (/\.(png|jpe?g)(?:$|[?#])/i.test(url)) return true;
  const head = bytes.subarray(0, 4);
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true; // PNG
  return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff; // JPEG
}

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

/**
 * 네이버 블로그 데스크톱 주소는 본문 없는 iframe 셸을 서빙한다 — 모바일 주소(m.blog)는
 * 서버 렌더링이라 본문이 HTML 에 있다. 지자체·기관이 블로그로 공고를 올리는 케이스 대응.
 */
export function naverBlogMobileUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "blog.naver.com" && host !== "www.blog.naver.com") return null;
  url.hostname = "m.blog.naver.com";
  return url.toString();
}

/** 본문이 얇을 때 시도할 형제 주소 (K-Startup ongoing↔deadline, 네이버 블로그 모바일) */
function siblingUrl(rawUrl: string): string | null {
  return kstartupSiblingUrl(rawUrl) ?? naverBlogMobileUrl(rawUrl);
}

/** 사이트 document_kind → 워커 kind. 컨테이너를 모르는 값은 text 로 취급한다. */
function presetKind(kind: string): SourceDocument["kind"] {
  switch (kind) {
    case "html":
    case "pdf":
    case "hwp":
    case "hwpx":
    case "text":
      return kind;
    default:
      return "text";
  }
}

/**
 * 프리셋(서버 동봉 문서)을 자체 수집 결과에 병합 — URL 중복은 자체 수집을 우선한다.
 * 프리셋도 redactDocuments 를 거치므로 연락처 마스킹은 동일하게 적용된다.
 */
function mergePresetDocuments(documents: SourceDocument[], presets: PresetDocument[] | undefined): void {
  if (!presets?.length) return;
  const seen = new Set(documents.map((document) => document.url));
  for (const preset of presets) {
    if (!preset.url || seen.has(preset.url)) continue;
    const text = preset.text?.trim() ?? "";
    if (text.length < MIN_ATTACHMENT_TEXT) continue;
    documents.push({ url: preset.url, kind: presetKind(preset.kind), title: preset.file_name, text });
    seen.add(preset.url);
  }
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
async function extractFile(
  bytes: Buffer,
  url: string,
  contentType: string | null,
  fileName: string | null,
  ocr?: CollectOptions["ocr"],
): Promise<ExtractedFile> {
  const name = (fileName ?? url).toLowerCase();

  if (looksLikePdf(contentType, url, bytes)) {
    return { kind: "pdf", text: await pdfToText(bytes) };
  }
  if (looksLikeImage(contentType, url, bytes)) {
    if (!(ocr?.enabled ?? ocrEnabled())) throw new Error("이미지 문서 — OCR 미설정 (FOUNDIN_OCR=docparse)");
    return { kind: "image", text: await imageToText(bytes, fileName, ocr) };
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
export async function collectDocuments(url: string, options: CollectOptions = {}): Promise<CollectResult> {
  const documents: SourceDocument[] = [];
  const skipped: SkippedAttachment[] = [];
  const ocrOn = options.ocr?.enabled ?? ocrEnabled();
  // OCR 호출도 수집기와 같은 fetch 구현을 쓴다 (테스트 주입 일관성)
  const ocrDeps: CollectOptions["ocr"] = ocrOn
    ? { ...options.ocr, enabled: true, fetchImpl: options.ocr?.fetchImpl ?? options.fetchImpl }
    : { ...options.ocr, enabled: false };

  let main;
  try {
    main = await guardedFetch(url, options);
  } catch (error) {
    // 원문 페이지 fetch 실패 — 프리셋(서버 캐시)이 있으면 그것만으로 진행한다.
    const presetOnly: SourceDocument[] = [];
    mergePresetDocuments(presetOnly, options.presetDocuments);
    if (presetOnly.length === 0) throw error;
    skipped.push({ url, kind: "원문 페이지 수집 실패 — 서버 캐시 문서로 진행", fileName: null });
    const presetResult = redactDocuments(presetOnly);
    return { documents: presetResult.masked, rawDocuments: presetResult.raw, skipped, contact: presetResult.contact };
  }

  // 메인 URL 이 문서 파일(또는 OCR 켠 경우 이미지) 직링크인 경우
  if (
    looksLikePdf(main.contentType, main.finalUrl, main.bytes) ||
    looksLikeCfb(main.bytes) ||
    (ocrOn && looksLikeImage(main.contentType, main.finalUrl, main.bytes))
  ) {
    const extracted = await extractFile(main.bytes, main.finalUrl, main.contentType, main.fileName, ocrDeps);
    if (extracted.text.length < MIN_PAGE_TEXT) {
      throw new Error(`${extracted.kind.toUpperCase()} 에서 텍스트를 추출하지 못했습니다 (스캔본 가능성)`);
    }
    documents.push({ url: main.finalUrl, kind: extracted.kind, title: main.fileName, text: extracted.text });
    mergePresetDocuments(documents, options.presetDocuments);
    const single = redactDocuments(documents);
    return { documents: single.masked, rawDocuments: single.raw, skipped, contact: single.contact };
  }

  let html = decodeText(main.bytes, main.contentType);
  let pageText = htmlToText(html);

  // 셸 폴백: 본문이 임계 미만이면 형제 주소(K-Startup ongoing↔deadline, 네이버 블로그 모바일)를
  // 시도해 더 긴 쪽을 쓴다.
  if (pageText.length < KSTARTUP_SHELL_TEXT) {
    const sibling = siblingUrl(main.finalUrl) ?? siblingUrl(url);
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

  // 서버가 본문 URL 과 같은 주소로 프리셋을 보냈다면 그것을 본문으로 쓴다.
  // 서버는 워커가 스스로 읽을 수 없는 사이트에만 source_page 를 동봉한다
  // (foundin.kr lib/briefs/claim-documents.ts 의 JS_RENDER_HOSTS — 청년정책·sbiz24).
  // 그 사이트들은 상세가 SPA 셸이라 페이지 fetch 로는 어느 공고든 같은 껍데기가 온다 —
  // 2026-08-08 실측: 청년정책 공고 46건 중 15건이 "다른 공고 내용"으로 발행돼 있었다.
  // ⚠ 이 폴백이 없으면 셸에서 뽑은 내용이 엉뚱한 공고에 붙는다. mergePresetDocuments 는
  //   같은 URL 을 seen 으로 걸러 버리므로, 본문 선택은 여기서 먼저 끝내야 한다.
  const bodyPreset = options.presetDocuments?.find(
    (preset) => preset.url === main.finalUrl || preset.url === url,
  );
  const bodyPresetText = bodyPreset?.text?.trim() ?? "";
  if (bodyPresetText.length >= MIN_PAGE_TEXT) {
    pageText = bodyPresetText;
  }

  if (pageText.length >= MIN_PAGE_TEXT) {
    documents.push({ url: main.finalUrl, kind: "html", title: extractTitle(html), text: pageText });
  } else if (!ocrOn && !options.presetDocuments?.length) {
    throw new Error("페이지에서 본문 텍스트를 찾지 못했습니다 (JS 렌더링 페이지 가능성)");
  }
  // (OCR 또는 프리셋이 있으면 본문이 빈약해도 계속 — 첨부·프리셋·포스터로 본문을 구한다)

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
      const extracted = await extractFile(attachment.bytes, attachment.finalUrl, attachment.contentType, fileName, ocrDeps);
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

  // 프리셋 병합 — 자체 첨부 수집이 놓친 문서를 서버 캐시로 보충한다 (URL 중복은 자체 우선).
  // OCR 임계 판정 전에 병합해, 프리셋으로 본문이 충분하면 불필요한 OCR 을 건너뛴다.
  mergePresetDocuments(documents, options.presetDocuments);

  // 인라인 포스터 OCR (옵트인): 본문+첨부 합산 텍스트가 얇으면 "포스터가 본문"인 공고 —
  // 본문 <img> 후보를 내려받아 OCR 로 본문을 구한다 (지자체·대학 카드뉴스형 공고 대응).
  if (ocrOn) {
    const totalChars = documents.reduce((sum, document) => sum + document.text.length, 0);
    if (totalChars < INLINE_OCR_TEXT) {
      let done = 0;
      for (const imageUrl of findInlineImages(html, main.finalUrl)) {
        if (done >= INLINE_OCR_LIMIT) break;
        try {
          const image = await guardedFetch(imageUrl, options);
          if (!looksLikeImage(image.contentType, image.finalUrl, image.bytes)) continue;
          const text = await imageToText(image.bytes, image.fileName, ocrDeps);
          if (text.length < MIN_ATTACHMENT_TEXT) continue;
          documents.push({ url: image.finalUrl, kind: "image", title: image.fileName ?? "포스터 이미지", text });
          done++;
        } catch (error) {
          skipped.push({
            url: imageUrl,
            kind: `OCR 실패: ${error instanceof Error ? error.message : "오류"}`.slice(0, 60),
            fileName: null,
          });
        }
      }
    }
  }

  if (documents.length === 0) {
    throw new Error("페이지에서 본문 텍스트를 찾지 못했습니다 (JS 렌더링·이미지 전용 페이지 가능성)");
  }

  const { masked, raw, contact } = redactDocuments(documents);
  return { documents: masked, rawDocuments: raw, skipped, contact };
}
