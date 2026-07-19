import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeEntities, extractTitle, findAttachmentLinks, htmlToText } from "../src/collect/html.js";
import { collectDocuments, kstartupSiblingUrl } from "../src/collect/index.js";
import { normalizeRawUrl } from "../src/collect/fetch.js";

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

describe("K-Startup 셸 폴백", () => {
  const ongoing = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=178072";
  const deadline = "https://www.k-startup.go.kr/web/contents/bizpbanc-deadline.do?schM=view&pbancSn=178072";

  it("kstartupSiblingUrl — ongoing↔deadline 상호 변환, 그 외 null", () => {
    expect(kstartupSiblingUrl(ongoing)).toBe(deadline);
    expect(kstartupSiblingUrl(deadline)).toBe(ongoing);
    expect(kstartupSiblingUrl("https://www.k-startup.go.kr/web/main/index.do")).toBeNull();
    expect(kstartupSiblingUrl("https://evilk-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=1")).toBeNull();
    expect(kstartupSiblingUrl("https://example.go.kr/notice?pbancSn=1")).toBeNull();
  });

  it("셸 페이지(본문 없음)면 형제 경로를 페치해 더 긴 본문을 쓴다", async () => {
    const shellHtml = "<html><body>K-Startup 창업지원포털&gt;사업공고&gt;모집중&gt;상세화면 본문 바로가기 사업공고 모집중 어쩌고 저쩌고 껍데기</body></html>";
    const fullBody = "지원대상: 예비창업자. 접수기간: 2026-06-10 ~ 2026-06-16. 제출서류: 사업계획서. ".repeat(20);
    const fullHtml = `<html><body>${fullBody}</body></html>`;
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const target = String(input);
      calls.push(target);
      const body = target.includes("bizpbanc-deadline") ? fullHtml : shellHtml;
      return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }) as typeof fetch;

    const result = await collectDocuments(ongoing, { fetchImpl, skipGuard: true });
    expect(calls.some((c) => c.includes("bizpbanc-deadline"))).toBe(true);
    expect(result.documents[0]!.url).toContain("bizpbanc-deadline");
    expect(result.documents[0]!.text).toContain("접수기간");
  });

  it("본문이 충분하면 형제 경로를 시도하지 않는다", async () => {
    const fullBody = "지원대상: 예비창업자. 접수기간: 2026-06-10 ~ 2026-06-16. 제출서류: 사업계획서. ".repeat(20);
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(`<html><body>${fullBody}</body></html>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as typeof fetch;

    await collectDocuments(ongoing, { fetchImpl, skipGuard: true });
    expect(calls.some((c) => c.includes("bizpbanc-deadline"))).toBe(false);
  });
});

describe("원문 URL 오염 보정 (normalizeRawUrl)", () => {
  it("HTML 이스케이프 잔재 &amp; 복원", () => {
    expect(normalizeRawUrl("https://x.go.kr/a?b=1&amp;c=2&amp;d=3")).toBe("https://x.go.kr/a?b=1&c=2&d=3");
  });
  it("스킴 없는 주소에 https:// 보정", () => {
    expect(normalizeRawUrl("www.btp.or.kr")).toBe("https://www.btp.or.kr");
    expect(normalizeRawUrl("btp.or.kr/notice?id=1")).toBe("https://btp.or.kr/notice?id=1");
  });
  it("정상 URL·비 URL 문자열은 그대로", () => {
    expect(normalizeRawUrl("https://ok.go.kr/x")).toBe("https://ok.go.kr/x");
    expect(normalizeRawUrl("not a url")).toBe("not a url");
  });
});
