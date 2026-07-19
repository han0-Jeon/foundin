import { describe, expect, it } from "vitest";
import { extractDocParseText, imageToText } from "../src/collect/ocr.js";
import { collectDocuments } from "../src/collect/index.js";

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(): Buffer {
  return Buffer.concat([PNG_HEAD, Buffer.alloc(64)]);
}

describe("Document Parse 응답 파싱 (방어적)", () => {
  it("content.text 우선", () => {
    expect(extractDocParseText({ content: { text: "지원 대상: 예비창업자", html: "<p>x</p>" } })).toBe(
      "지원 대상: 예비창업자",
    );
  });
  it("text 없으면 markdown → html 순 폴백", () => {
    expect(extractDocParseText({ content: { markdown: "## 접수 기간" } })).toBe("## 접수 기간");
    expect(extractDocParseText({ content: { html: "<p>마감: 8월 14일</p>" } })).toContain("마감: 8월 14일");
  });
  it("content 없으면 elements 텍스트 연결", () => {
    expect(
      extractDocParseText({ elements: [{ content: { text: "1행" } }, { content: { text: "2행" } }] }),
    ).toBe("1행\n2행");
  });
});

describe("imageToText — Document Parse 호출", () => {
  it("multipart 로 문서를 보내고 텍스트를 돌려받는다", async () => {
    let captured: { url: string; auth: string | null; hasForm: boolean } | null = null;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured = {
        url: String(input),
        auth: (init?.headers as Record<string, string>)?.Authorization ?? null,
        hasForm: init?.body instanceof FormData,
      };
      return new Response(JSON.stringify({ content: { text: "포스터 텍스트: 지원 자격 예비창업자" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const text = await imageToText(pngBytes(), "poster.png", { fetchImpl, apiKey: "test-key" });
    expect(text).toContain("지원 자격 예비창업자");
    expect(captured!.url).toContain("document-digitization");
    expect(captured!.auth).toBe("Bearer test-key");
    expect(captured!.hasForm).toBe(true);
  });

  it("HTTP 오류·빈 결과는 사유와 함께 throw", async () => {
    const failImpl = (async () => new Response("quota exceeded", { status: 429 })) as typeof fetch;
    await expect(imageToText(pngBytes(), null, { fetchImpl: failImpl, apiKey: "k" })).rejects.toThrow(/429/);
    const emptyImpl = (async () =>
      new Response(JSON.stringify({ content: {} }), { status: 200 })) as typeof fetch;
    await expect(imageToText(pngBytes(), null, { fetchImpl: emptyImpl, apiKey: "k" })).rejects.toThrow(/텍스트 없음/);
  });
});

describe("수집기 이미지 처리", () => {
  const body = "지원사업 공고 안내. ".repeat(10);
  // 실세계 이미지 첨부는 확장자 없는 다운로드 엔드포인트로 온다 (100건 실측과 동일 형태)
  const pageHtml = `<html><body>${body}<a href="/afile/fileDownload/P123">포스터 다운로드</a></body></html>`;
  const OCR_TEXT = "포스터 본문: 접수 기간 2026-08-01 ~ 2026-08-14 16:00, 지원 대상 예비창업자 및 7년 이내 창업기업, 문의 창업지원과";

  function fetchRouter(ocrText: string | null): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const target = String(input);
      if (target.includes("document-digitization")) {
        return new Response(JSON.stringify({ content: { text: ocrText ?? "" } }), { status: 200 });
      }
      if (target.includes("fileDownload")) {
        return new Response(new Uint8Array(pngBytes()), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      void init;
      return new Response(pageHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }) as typeof fetch;
  }

  it("OCR 꺼짐(기본) → 이미지 첨부는 skipped 로 정직 표기", async () => {
    const result = await collectDocuments("https://example.go.kr/notice/1", {
      fetchImpl: fetchRouter(null),
      skipGuard: true,
      ocr: { enabled: false },
    });
    expect(result.documents.some((d) => d.kind === "image")).toBe(false);
    expect(result.skipped.some((s) => /OCR 미설정/.test(s.kind))).toBe(true);
  });

  it("OCR 켜짐 → 이미지 첨부를 읽어 문서로 포함", async () => {
    const result = await collectDocuments("https://example.go.kr/notice/1", {
      fetchImpl: fetchRouter(OCR_TEXT),
      skipGuard: true,
      ocr: { enabled: true, apiKey: "test-key" },
    });
    const image = result.documents.find((d) => d.kind === "image");
    expect(image).toBeDefined();
    expect(image!.text).toContain("접수 기간");
  });

  it("본문 빈약 + 인라인 포스터 → OCR 로 본문을 구한다", async () => {
    const thinHtml = `<html><body>공고 안내입니다. 자세한 내용은 포스터 참조. 접수 마감 유의. 문의는 아래.
      <img src="/img/logo.png"><img src="/img/poster_2026.jpg"></body></html>`;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const target = String(input);
      if (target.includes("document-digitization")) {
        return new Response(
          JSON.stringify({ content: { text: "포스터 본문: 지원 대상 예비창업자 및 창업 7년 이내 기업, 접수 마감 2026년 8월 14일 16시, 신청은 온라인 접수" } }),
          { status: 200 },
        );
      }
      if (target.endsWith(".jpg")) {
        return new Response(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32)])), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response(thinHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }) as typeof fetch;

    const result = await collectDocuments("https://example.go.kr/notice/2", {
      fetchImpl,
      skipGuard: true,
      ocr: { enabled: true, apiKey: "test-key" },
    });
    const image = result.documents.find((d) => d.kind === "image");
    expect(image).toBeDefined();
    expect(image!.url).toContain("poster_2026.jpg"); // logo.png 는 휴리스틱으로 제외
    expect(image!.text).toContain("지원 대상 예비창업자");
  });
});
