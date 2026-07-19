// PDF 텍스트 추출 — pdf-parse 코어 모듈을 직접 import (패키지 index 의 디버그 코드 우회).

export async function pdfToText(bytes: Buffer): Promise<string> {
  const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
  const parsed = await pdfParse(bytes);
  return parsed.text
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
