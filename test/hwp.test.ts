import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import * as CFB from "cfb";
import { strToU8, zipSync } from "fflate";
import { docxToText, extractSectionText, hwpToText, hwpxToText } from "../src/collect/hwp.js";

const HWPTAG_PARA_TEXT = 67;

/** 테스트용 HWP 레코드 생성 (tag, UTF-16LE 본문) */
function paraTextRecord(text: string, controls: number[] = []): Buffer {
  const codes: number[] = [...controls, ...[...text].map((ch) => ch.charCodeAt(0))];
  const payload = Buffer.alloc(codes.length * 2);
  codes.forEach((code, i) => payload.writeUInt16LE(code, i * 2));
  const header = Buffer.alloc(4);
  header.writeUInt32LE((payload.length << 20) | HWPTAG_PARA_TEXT, 0);
  return Buffer.concat([header, payload]);
}

function fileHeader(flags: number): Buffer {
  const buf = Buffer.alloc(256);
  buf.write("HWP Document File", 0, "latin1");
  buf.writeUInt32LE(0x05000000, 32); // version
  buf.writeUInt32LE(flags, 36);
  return buf;
}

function buildHwp(section: Buffer, flags: number): Buffer {
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, "/FileHeader", fileHeader(flags));
  CFB.utils.cfb_add(container, "/BodyText/Section0", section);
  return Buffer.from(CFB.write(container, { type: "buffer" }) as Buffer);
}

describe("HWP v5 추출", () => {
  it("레코드 워커가 본문 텍스트를 추출한다", () => {
    const section = Buffer.concat([
      paraTextRecord("지원금 최대 5,000만원"),
      paraTextRecord("공고일 기준 사업자등록을 완료한 기업"),
    ]);
    const text = extractSectionText(section);
    expect(text).toContain("지원금 최대 5,000만원");
    expect(text).toContain("사업자등록을 완료한 기업");
  });

  it("인라인 컨트롤(8 WCHAR)을 건너뛴다", () => {
    // 컨트롤 코드 3 + 7개 더미 WCHAR 후 본문
    const section = paraTextRecord("마감일 안내", [3, 0, 0, 0, 0, 0, 0, 0]);
    expect(extractSectionText(section)).toContain("마감일 안내");
  });

  it("비압축 HWP 파일 전체 추출", () => {
    const hwp = buildHwp(paraTextRecord("서류 제출 마감 2026. 8. 14."), 0);
    expect(hwpToText(hwp)).toContain("서류 제출 마감 2026. 8. 14.");
  });

  it("압축 HWP (raw deflate) 추출", () => {
    const section = deflateRawSync(paraTextRecord("자부담 30% 이상"));
    const hwp = buildHwp(section, 0b1);
    expect(hwpToText(hwp)).toContain("자부담 30% 이상");
  });

  it("암호화 플래그 → 명시적 실패", () => {
    const hwp = buildHwp(paraTextRecord("비밀"), 0b10);
    expect(() => hwpToText(hwp)).toThrow(/암호화/);
  });
});

describe("HWPX 추출", () => {
  it("섹션 XML 의 hp:t 텍스트를 문단 단위로 추출", () => {
    const xml = `<?xml version="1.0"?><hs:sec xmlns:hp="x">
      <hp:p><hp:run><hp:t>신청 자격: 창업 7년 이내</hp:t></hp:run></hp:p>
      <hp:p><hp:run><hp:t>지원금 최대 5,000만원</hp:t></hp:run></hp:p>
    </hs:sec>`;
    const zip = Buffer.from(zipSync({ "Contents/section0.xml": strToU8(xml), "mimetype": strToU8("hwpx") }));
    const text = hwpxToText(zip);
    expect(text).toContain("신청 자격: 창업 7년 이내");
    expect(text).toContain("지원금 최대 5,000만원");
  });

  it("섹션 없는 ZIP → 명시적 실패", () => {
    const zip = Buffer.from(zipSync({ "readme.txt": strToU8("hello") }));
    expect(() => hwpxToText(zip)).toThrow(/섹션 없음/);
  });
});

describe("DOCX 텍스트 추출", () => {
  it("word/document.xml 의 w:t 노드 수집 — run 분절은 공백 없이 연결", () => {
    const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
      <w:p><w:r><w:t>신청 자격: 창업 </w:t></w:r><w:r><w:t>7년 이내</w:t></w:r></w:p>
      <w:p><w:r><w:t>접수 기간: 2026-08-01 ~ 2026-08-14</w:t></w:r></w:p>
    </w:body></w:document>`;
    const zip = Buffer.from(zipSync({ "word/document.xml": strToU8(xml) }));
    const text = docxToText(zip);
    expect(text).toContain("신청 자격: 창업 7년 이내");
    expect(text).toContain("접수 기간: 2026-08-01 ~ 2026-08-14");
  });

  it("document.xml 없는 ZIP → 명시적 실패", () => {
    const zip = Buffer.from(zipSync({ "readme.txt": strToU8("hello") }));
    expect(() => docxToText(zip)).toThrow(/DOCX 본문 없음/);
  });
});
