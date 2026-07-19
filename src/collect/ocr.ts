// 이미지 포스터 OCR — Upstage Document Parse (2026-07-19 한영 지시: "포스터까지 읽는다").
// 지자체·대학 공고는 카드뉴스형 포스터 하나만 올리는 경우가 많다 (100건 실측: 스킵 25건 중 이미지 15건).
//
// 옵트인: FOUNDIN_OCR=docparse + UPSTAGE_API_KEY 있을 때만 동작. 미설정 시 기존대로
// "못 읽음" 표기 (비용 통제 — Document Parse 는 페이지당 과금, 콘솔 무료 크레딧 소진 후 유료).
// 실패는 전부 throw → 호출부가 skipped 로 강등 (fail-open 아님: 읽은 척하지 않는다).

const DOC_DIGITIZATION_URL = "https://api.upstage.ai/v1/document-digitization";
const DEFAULT_TIMEOUT_MS = 60_000;

export interface OcrDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  /** document-parse(레이아웃·표 보존, 기본) | ocr(순수 텍스트, 저가) */
  model?: string;
  timeoutMs?: number;
}

export function ocrEnabled(): boolean {
  return process.env.FOUNDIN_OCR === "docparse" && Boolean(process.env.UPSTAGE_API_KEY);
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|tr|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface DocParseResponse {
  content?: { text?: string; markdown?: string; html?: string };
  elements?: { content?: { text?: string; markdown?: string; html?: string } }[];
}

/** Document Parse 응답에서 텍스트를 방어적으로 꺼낸다 (text → markdown → html → elements 순) */
export function extractDocParseText(data: DocParseResponse): string {
  const c = data.content;
  if (c?.text?.trim()) return c.text.trim();
  if (c?.markdown?.trim()) return c.markdown.trim();
  if (c?.html?.trim()) return stripHtml(c.html);
  const parts = (data.elements ?? [])
    .map((element) => element.content?.text ?? element.content?.markdown ?? (element.content?.html ? stripHtml(element.content.html) : ""))
    .filter(Boolean);
  return parts.join("\n").trim();
}

/** 이미지(포스터)·스캔 문서 바이트 → 텍스트. 실패 시 사유와 함께 throw. */
export async function imageToText(bytes: Buffer, fileName: string | null, deps: OcrDeps = {}): Promise<string> {
  const apiKey = deps.apiKey ?? process.env.UPSTAGE_API_KEY ?? "";
  if (!apiKey) throw new Error("OCR 키 없음 (UPSTAGE_API_KEY)");
  const fetchImpl = deps.fetchImpl ?? fetch;

  const form = new FormData();
  form.append("document", new Blob([new Uint8Array(bytes)]), fileName ?? "poster.png");
  form.append("model", deps.model ?? process.env.FOUNDIN_OCR_MODEL ?? "document-parse");
  form.append("output_formats", '["text","markdown"]');

  const response = await fetchImpl(DOC_DIGITIZATION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`OCR HTTP ${response.status}: ${detail}`);
  }
  const text = extractDocParseText((await response.json()) as DocParseResponse);
  if (!text) throw new Error("OCR 결과 텍스트 없음");
  return text;
}
