// SPA 셸 사이트의 본문은 서버 프리셋이 이긴다 (2026-08-08).
// 청년정책·sbiz24 상세는 어느 공고든 같은 껍데기를 서빙해, 페이지에서 뽑은 내용이
// 엉뚱한 공고에 붙는다. 서버는 그런 호스트에만 source_page 를 동봉한다.

import { describe, expect, it } from "vitest";
import { collectDocuments } from "../src/collect/index.js";

const URL_A = "https://www.youthcenter.go.kr/youthPolicy/ythPlcyTotalSearch/ythPlcyDetail/20260408005400212600";
// 어느 정책 ID 로 받아도 같은 셸이 온다 (실측)
const SPA_SHELL = `<html><head><title>청년정책 통합검색 &lt; 청년정책 - 온통청년</title></head><body>
  <div class="board_view"><h2>스타트업 원스톱 지원센터</h2>
  <p>${"기술창업 기반의 창업가가 직면하는 법률, 세무, 경영 등 복합적인 애로해결을 지원합니다. ".repeat(6)}</p></div></body></html>`;

const PRESET_TEXT = [
  "정책명: 서산시 창업보육센터 지원",
  "정책번호: 20260504005400213070",
  "정책 설명: 창업기업 육성 및 지원을 위한 창업보육센터 활성화 촉진",
  "지원 내용: 마케팅 및 홍보지원, 시제품 제작 지원, 창업 교육 등",
  "신청 기간: 2026-05-01 ~ 2026-09-30",
].join("\n\n");

const fetchShell: typeof fetch = (async () =>
  new Response(SPA_SHELL, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;

describe("SPA 셸 본문 — 서버 프리셋 우선", () => {
  it("본문 URL 과 같은 프리셋이 있으면 셸 대신 그것을 본문으로 쓴다", async () => {
    const result = await collectDocuments(URL_A, {
      fetchImpl: fetchShell,
      skipGuard: true,
      presetDocuments: [{ url: URL_A, file_name: null, kind: "text", text: PRESET_TEXT }],
    });
    const body = result.documents[0]!;
    expect(body.text).toContain("서산시 창업보육센터");
    // 셸에서 뽑힌 다른 공고 내용이 본문에 섞이지 않는다
    expect(body.text).not.toContain("스타트업 원스톱 지원센터");
    // 같은 URL 이 문서로 두 번 들어가지 않는다
    expect(result.documents.filter((d) => d.url === URL_A)).toHaveLength(1);
  });

  it("프리셋이 없으면 종전대로 페이지 텍스트를 쓴다", async () => {
    const result = await collectDocuments(URL_A, { fetchImpl: fetchShell, skipGuard: true });
    expect(result.documents[0]!.text).toContain("스타트업 원스톱 지원센터");
  });

  it("프리셋이 너무 짧으면 무시한다 (추출 실패 잔재)", async () => {
    const result = await collectDocuments(URL_A, {
      fetchImpl: fetchShell,
      skipGuard: true,
      presetDocuments: [{ url: URL_A, file_name: null, kind: "text", text: "정책명: x" }],
    });
    expect(result.documents[0]!.text).toContain("스타트업 원스톱 지원센터");
  });
});
