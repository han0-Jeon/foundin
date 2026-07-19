import { describe, expect, it } from "vitest";
import { extractContact, maskContact } from "../src/collect/contact.js";

const notice = `2026년 창업지원 사업 공고
지원금 최대 5,000만원, 접수 2026. 8. 14. 까지
문의처: 창업지원팀 홍길동 주무관 ☎ 02-123-4567 (이메일: hong@korea.kr)
담당: 김철수 사무관 010-9876-5432
대표번호 1588-1234`;

describe("연락처 추출 (표시용)", () => {
  it("전화·이메일·문의 줄을 뽑는다", () => {
    const contact = extractContact(notice);
    expect(contact.phones).toContain("02-123-4567");
    expect(contact.phones).toContain("010-9876-5432");
    expect(contact.phones).toContain("1588-1234");
    expect(contact.emails).toContain("hong@korea.kr");
    expect(contact.lines.some((line) => line.includes("창업지원팀"))).toBe(true);
  });

  it("연락처 없는 공고는 빈 결과", () => {
    const contact = extractContact("지원금 최대 1억원. 접수 2026-08-14 까지. 대상: 창업 7년 이내.");
    expect(contact.phones).toHaveLength(0);
    expect(contact.emails).toHaveLength(0);
  });

  it("날짜·금액을 전화번호로 오탐하지 않는다", () => {
    const contact = extractContact("접수기간 2026-08-14 ~ 2026-09-30, 지원금 5,000만원, 사업자번호 123-45-67890");
    expect(contact.phones).toHaveLength(0);
  });
});

describe("연락처 마스킹 (Solar 전송용)", () => {
  it("전화·이메일·담당자 이름을 가린다", () => {
    const masked = maskContact(notice);
    expect(masked).not.toContain("02-123-4567");
    expect(masked).not.toContain("010-9876-5432");
    expect(masked).not.toContain("hong@korea.kr");
    expect(masked).not.toContain("홍길동");
    expect(masked).not.toContain("김철수");
    expect(masked).toContain("[연락처]");
    expect(masked).toContain("[이메일]");
    expect(masked).toContain("[담당자]");
  });

  it("자격·마감·금액 본문은 그대로 둔다", () => {
    const masked = maskContact(notice);
    expect(masked).toContain("최대 5,000만원");
    expect(masked).toContain("2026. 8. 14.");
    expect(masked).toContain("창업지원 사업");
  });

  it("일반 한글 단어를 담당자로 오탐하지 않는다", () => {
    const masked = maskContact("창업 기업 대상, 서울 소재 법인, 기술 분야 우대");
    expect(masked).toBe("창업 기업 대상, 서울 소재 법인, 기술 분야 우대");
  });
});
