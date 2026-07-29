import { describe, expect, it } from "vitest";
import {
  extractSourceUrl,
  pickNonAnnouncement,
  extractTitle,
  parseSitemap,
  shuffle,
  titleFromSlug,
} from "../src/demo/candidates.js";

describe("parseSitemap — 공고 상세만 추린다", () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://foundin.kr/</loc></url>
    <url><loc>https://foundin.kr/programs</loc></url>
    <url><loc>https://foundin.kr/programs/source/kstartup</loc></url>
    <url><loc>https://foundin.kr/programs/category/creative</loc></url>
    <url><loc>https://foundin.kr/programs/some-notice-a6c8560b91c4437f8c47efcf4f0f670c</loc></url>
    <url><loc>https://foundin.kr/insights/foo</loc></url>
  </urlset>`;

  it("목록 페이지(전체·소스별·분야별)는 전부 제외하고 상세만 남긴다", () => {
    expect(parseSitemap(xml)).toEqual([
      "https://foundin.kr/programs/some-notice-a6c8560b91c4437f8c47efcf4f0f670c",
    ]);
  });

  it("공고와 무관한 경로는 안 섞인다", () => {
    expect(parseSitemap(xml).some((u) => u.includes("/insights/"))).toBe(false);
  });

  it("빈 입력이면 빈 배열", () => {
    expect(parseSitemap("")).toEqual([]);
  });
});

describe("extractSourceUrl — 상세 페이지에서 원문 링크", () => {
  it("쿼리가 붙은 구체적인 링크를 고른다 (목록 URL 이 아니라)", () => {
    const html = `
      <a href="https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do">목록</a>
      <a href="https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&amp;pbancSn=177978">원문</a>`;
    expect(extractSourceUrl(html)).toBe(
      "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=177978",
    );
  });

  it("&amp; 를 & 로 되돌린다", () => {
    const html = `"https://www.mss.go.kr/site/smba/ex/bbs/View.do?cbIdx=310&amp;bcIdx=1068619"`;
    expect(extractSourceUrl(html)).toContain("cbIdx=310&bcIdx=1068619");
  });

  it("foundin.kr 자기 링크는 고르지 않는다", () => {
    const html = `"https://foundin.kr/programs/other-aaaaaaaabbbbccccddddeeeeffff0000"`;
    expect(extractSourceUrl(html)).toBeNull();
  });

  it("한국 도메인이 아닌 링크(문의 폼 등)는 거른다", () => {
    const html = `"https://forms.gle/9NWYbTBgouSY6oAz7xxxxxxxxxxxx"`;
    expect(extractSourceUrl(html)).toBeNull();
  });

  it("깨진 URL 이 섞여도 죽지 않는다", () => {
    const html = `"http://" "https://www.k-startup.go.kr/web/contents/x.do?a=1"`;
    expect(extractSourceUrl(html)).toContain("k-startup.go.kr");
  });
});

describe("extractTitle / titleFromSlug", () => {
  it("<title> 에서 사이트명을 떼어낸다", () => {
    const html = "<title>2026년 ICT혁신센터 입주기업 모집공고 | Foundin</title>";
    expect(extractTitle(html, "https://foundin.kr/programs/x-" + "a".repeat(32))).toBe(
      "2026년 ICT혁신센터 입주기업 모집공고",
    );
  });

  it("<title> 이 없으면 slug 에서 유추한다", () => {
    const url = "https://foundin.kr/programs/2026-deeptech-studio-2ded179200cc412182b4d38f3d8b97be";
    expect(extractTitle("<html></html>", url)).toBe("2026 deeptech studio");
  });

  it("slug 끝 32hex 를 떼고 하이픈을 공백으로", () => {
    const url = "https://foundin.kr/programs/abc-def-a6c8560b91c4437f8c47efcf4f0f670c";
    expect(titleFromSlug(url)).toBe("abc def");
  });

  it("퍼센트 인코딩된 한글 slug 도 복원한다", () => {
    const url = "https://foundin.kr/programs/%EA%B3%B5%EA%B3%A0-" + "a".repeat(32);
    expect(titleFromSlug(url)).toBe("공고");
  });

  it("URL 이 깨져도 죽지 않는다", () => {
    expect(titleFromSlug("not a url")).toBe("(제목 없음)");
  });
});

describe("pickNonAnnouncement — 반려 시연용 표본", () => {
  it("항상 하나를 돌려준다", () => {
    for (const r of [0, 0.3, 0.99]) {
      expect(pickNonAnnouncement(() => r).url).toMatch(/^https:\/\//);
    }
  });

  it("표본은 개별 공고가 아니라 포털 목록·메인이다 (마감돼도 안 썩는 URL)", () => {
    // 개별 공고 URL 은 상세 파라미터(pbancSn 등)를 갖는다. 표본엔 없어야 한다.
    for (const r of [0, 0.3, 0.6, 0.99]) {
      expect(pickNonAnnouncement(() => r).url).not.toMatch(/pbancSn=|bcIdx=|ythPlcyDetail/);
    }
  });

  it("고르면 무엇을 보게 되는지 설명이 붙는다", () => {
    expect(pickNonAnnouncement(() => 0).note).toContain("반려");
  });
});

describe("shuffle", () => {
  it("원소를 잃거나 더하지 않는다", () => {
    const input = [1, 2, 3, 4, 5];
    expect(shuffle(input, () => 0.5).sort()).toEqual(input);
  });

  it("원본을 변경하지 않는다", () => {
    const input = [1, 2, 3];
    shuffle(input, () => 0.5);
    expect(input).toEqual([1, 2, 3]);
  });

  it("rng 를 주입하면 결정적이다 (테스트 재현성)", () => {
    const a = shuffle([1, 2, 3, 4, 5], () => 0.42);
    const b = shuffle([1, 2, 3, 4, 5], () => 0.42);
    expect(a).toEqual(b);
  });
});
