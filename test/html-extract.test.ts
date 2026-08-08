// 본문 추출 규칙 — 웹(foundin.kr) repo 의 tests/unit/program-document-extract.test.ts 와
// 같은 픽스처·같은 기대값을 쓴다. 두 추출기가 갈라지면 브리프 인용을 근거 뷰어가 못 찾는다.

import { describe, expect, it } from "vitest";
import { htmlToText } from "../src/collect/html.js";
import { normalizeForMatch } from "../src/verify/quotes.js";

describe("htmlToText — 표·라벨쌍 구조 보존", () => {
  it("K-Startup 식 tit/txt 라벨쌍을 한 줄에 잇는다", () => {
    const html = `
      <div class="table_inner">
        <p class="tit">지원분야</p>
        <p class="txt">행사ㆍ네트워크</p>
      </div>
      <div class="table_inner">
        <p class="tit">대상연령</p>
        <p class="txt">전체</p>
      </div>`;

    expect(htmlToText(html)).toBe("지원분야 | 행사ㆍ네트워크\n대상연령 | 전체");
  });

  it("표의 한 행을 한 줄로 잇는다 (셀은 구분자, 행은 개행)", () => {
    const html = `<table><tbody>
      <tr><th>접수기간</th><td>2026-07-10 ~ 2026-08-10 16:00</td></tr>
      <tr><th>지원규모</th><td>40개사</td></tr>
    </tbody></table>`;

    expect(htmlToText(html)).toBe("접수기간 | 2026-07-10 ~ 2026-08-10 16:00\n지원규모 | 40개사");
  });

  it("dl/dt/dd 도 같은 규칙", () => {
    expect(htmlToText("<dl><dt>소관부처</dt><dd>중소벤처기업부</dd></dl>")).toBe("소관부처 | 중소벤처기업부");
  });

  it("짝 없는 tit 은 종전대로 줄을 나눈다 (잘못 잇지 않는다)", () => {
    const html = `<p class="tit">공고 제목</p><p>본문 문단입니다</p>`;
    expect(htmlToText(html)).toBe("공고 제목\n본문 문단입니다");
  });

  it("HTML 주석을 지운다 (--> 가 본문에 새지 않는다)", () => {
    const html = "<p>지원대상<!-- 내부 메모: 검수 전 --></p><p>예비창업자</p>";
    const text = htmlToText(html);
    expect(text).not.toContain("-->");
    expect(text).not.toContain("내부 메모");
    expect(text).toBe("지원대상\n예비창업자");
  });

  it("nav·header·footer·aside 메뉴 덤프를 걷어낸다", () => {
    const html = `
      <nav><ul><li>사업소개</li><li>알림마당</li><li>고객센터</li></ul></nav>
      <header><a href="/">기관 로고</a></header>
      <p>접수기간: 2026-08-10 까지</p>
      <aside><a href="/sitemap">사이트맵</a></aside>
      <footer>주소 서울시 · 대표전화 1234</footer>`;

    const text = htmlToText(html);
    expect(text).toBe("접수기간: 2026-08-10 까지");
    expect(text).not.toContain("알림마당");
    expect(text).not.toContain("사이트맵");
    expect(text).not.toContain("대표전화");
  });

  it("본문 컨테이너(<main>)가 있으면 그 밖의 잡음을 버린다", () => {
    const body = "지원대상 예비창업자 및 창업 3년 이내 기업. ".repeat(20);
    const html = `<div class="gnb">전체메뉴 로그인 회원가입</div><main><p>${body}</p></main>`;

    const text = htmlToText(html);
    expect(text).toContain("예비창업자");
    expect(text).not.toContain("전체메뉴");
  });

  it("본문 컨테이너 후보가 너무 짧으면 다음 후보로 넘어간다", () => {
    const body = "신청자격은 공고일 기준 사업자등록을 완료한 창업 7년 이내 기업입니다. ".repeat(20);
    // <main> 은 껍데기(400자 미만) — 실제 본문은 board_view div 에 있다
    const html = `<main><p>본문 준비중</p></main><div class="board_view"><p>${body}</p></div>`;

    const text = htmlToText(html);
    expect(text).toContain("창업 7년 이내");
    expect(text).not.toContain("본문 준비중");
  });

  it("본문 컨테이너를 못 찾으면 문서 전체를 쓴다 (안전 폴백)", () => {
    const html = "<html><body><p>지원대상: 예비창업자</p><p>마감: 2026-08-10</p></body></html>";
    expect(htmlToText(html)).toBe("지원대상: 예비창업자\n마감: 2026-08-10");
  });

  it("script·style 은 그대로 제거", () => {
    const html = `<script>track("x")</script><style>.a{display:none}</style><p>본문</p>`;
    const text = htmlToText(html);
    expect(text).toBe("본문");
  });

  it("빈 셀은 접고 줄 끝 잔여 구분자는 지운다", () => {
    const html = "<table><tr><td>지원분야</td><td></td><td>사업화</td><td></td></tr></table>";
    expect(htmlToText(html)).toBe("지원분야 | 사업화");
  });
});

describe("normalizeForMatch — 구분자는 공백과 동치", () => {
  it("개행으로 쪼개진 옛 텍스트와 구분자로 이어진 새 텍스트가 같은 문자열로 접힌다", () => {
    const before = normalizeForMatch("지원분야\n사업화");
    const after = normalizeForMatch("지원분야 | 사업화");
    expect(after).toBe(before);
    expect(after).toBe("지원분야 사업화");
  });

  it("개편 전 텍스트에서 뽑힌 인용이 개편 후 텍스트에서도 포함 관계를 유지한다", () => {
    const quote = normalizeForMatch("접수기간 2026-07-10 ~ 2026-08-10 16:00");
    const fresh = normalizeForMatch(htmlToText(
      "<table><tr><th>접수기간</th><td>2026-07-10 ~ 2026-08-10 16:00</td></tr></table>",
    ));
    expect(fresh.includes(quote)).toBe(true);
  });
});
