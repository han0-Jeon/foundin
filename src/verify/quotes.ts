// 인용 대조 — LLM 이 "원문에서 복사했다"고 주장하는 인용문이 실제 원문에 존재하는지 결정적으로 검사.
// 환각 인용을 걸러내는 1차 방어선.

import type { SourceDocument } from "../types.js";

export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[""''「」『』]/g, '"')
    .replace(/[·ㆍ•]/g, "·")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 공백까지 제거한 초정규화 — 표·줄바꿈으로 쪼개진 원문 대응 */
function tighten(text: string): string {
  return normalizeForMatch(text).replace(/[\s\-–—]/g, "");
}

export interface QuoteIndex {
  normalized: string[];
  tightened: string[];
}

export function buildQuoteIndex(documents: SourceDocument[]): QuoteIndex {
  return {
    normalized: documents.map((document) => normalizeForMatch(document.text)),
    tightened: documents.map((document) => tighten(document.text)),
  };
}

export function quoteExists(quote: string, index: QuoteIndex): boolean {
  const normalized = normalizeForMatch(quote);
  if (normalized.length < 4) return false;
  if (index.normalized.some((text) => text.includes(normalized))) return true;
  const tight = tighten(quote);
  return tight.length >= 4 && index.tightened.some((text) => text.includes(tight));
}
