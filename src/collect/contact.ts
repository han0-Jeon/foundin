// 연락처 처리 — 개인정보 경계.
// 정부 공고문에는 담당자 이름·전화·이메일이 흔히 들어간다. 이건 "타인의 개인정보"라
//   ① Solar 로 보내는 텍스트에선 가리고 (maskContact)
//   ② 우리 코드가 직접 뽑아 브리프에 담아 사용자에게만 보여준다 (extractContact)
// 즉 연락처는 프로필처럼 "외부 LLM 엔 안 가고 우리 안에서만 도는 정보"다.

import type { ContactInfo } from "../types.js";

export type { ContactInfo };

// 한국 전화번호: 지역번호(02, 0XX) + 3~4 + 4, 모바일(010), 대표번호(15xx/16xx/18xx).
// 앞뒤가 숫자면 제외 → 날짜(2026-08-14)·사업자번호(3-2-5)·금액과 오탐 방지.
const PHONE = /(?<![\d-])(?:0\d{1,2}[-.)\s]?\d{3,4}[-.\s]?\d{4}|1[5-9]\d{2}[-.\s]?\d{4})(?![\d-])/g;
const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// 이름+직함 (홍길동 주무관) 또는 직함+이름 (담당자: 홍길동)
const TITLES = "주무관|사무관|서기관|연구원|연구사|주임연구원|매니저|팀장|과장|부장|차장|대리|담당자|담당|선임|책임|주임";
const NAME_AFTER_TITLE = new RegExp(`([가-힣]{2,4})\\s*(?:${TITLES})(?![가-힣])`, "g");
const NAME_BEFORE = new RegExp(`((?:담당자|담당|문의자|작성자)\\s*[:：]?\\s*)([가-힣]{2,4})(?![가-힣])`, "g");

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/** 원문(마스킹 전)에서 연락처를 뽑는다 — 표시 전용, Solar 로 가지 않는다. */
export function extractContact(text: string): ContactInfo {
  return {
    phones: dedupe(text.match(PHONE) ?? []),
    emails: dedupe(text.match(EMAIL) ?? []),
  };
}

export function hasContact(contact: ContactInfo): boolean {
  return contact.phones.length > 0 || contact.emails.length > 0;
}

/** Solar 로 보내는 텍스트에서 연락처를 가린다. 자격·마감·서류 추출에는 영향 없다. */
export function maskContact(text: string): string {
  return text
    .replace(EMAIL, "[이메일]")
    .replace(PHONE, "[연락처]")
    .replace(NAME_BEFORE, (_, prefix: string) => `${prefix}[담당자]`)
    .replace(NAME_AFTER_TITLE, (match: string, name: string) => match.replace(name, "[담당자]"));
}
