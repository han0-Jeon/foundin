import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeEntities, extractTitle, findAttachmentLinks, htmlToText } from "../src/collect/html.js";

const fixture = readFileSync(join(__dirname, "../fixtures/sample-notice.html"), "utf8");

describe("HTML 텍스트 추출", () => {
  it("script·style 제거 + 본문 보존", () => {
    const text = htmlToText(fixture);
    expect(text).not.toContain("tracking code");
    expect(text).not.toContain("display: none");
    expect(text).toContain("공고일 기준 사업자등록을 완료한 창업 7년 이내 기업");
    expect(text).toContain("2026. 8. 14.(금) 16:00");
  });
  it("제목 추출", () => {
    expect(extractTitle(fixture)).toContain("서울 초기창업 성장지원");
  });
  it("엔티티 디코드", () => {
    expect(decodeEntities("A&amp;B &#44536;&#47532;&#44256; &lt;C&gt;")).toBe("A&B 그리고 <C>");
  });
});

describe("첨부 링크 탐색", () => {
  it("pdf 는 수집 후보, hwp 는 종류 판별", () => {
    const links = findAttachmentLinks(fixture, "https://example.go.kr/notice/241");
    const kinds = links.map((link) => link.kind).sort();
    expect(kinds).toContain("pdf");
    expect(kinds).toContain("hwp");
    expect(links.every((link) => link.url.startsWith("https://example.go.kr/"))).toBe(true);
  });
});
