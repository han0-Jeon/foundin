// HWP/HWPX 텍스트 추출 — 한국 공공 공고 첨부의 사실상 표준 포맷.
//
// HWP v5 (.hwp): CFB(Compound File Binary) 컨테이너. BodyText/Section* 스트림을
//   (압축 시 raw-deflate 해제 후) 레코드 단위로 걸어 HWPTAG_PARA_TEXT 의 UTF-16LE 본문만 추출.
// HWPX (.hwpx): ZIP + OWPML XML. Contents/section*.xml 의 <hp:t> 텍스트 노드를 모은다.
//
// 암호화·배포용(DRM) 문서는 읽을 수 없으므로 명시적 에러 → 수집기가 "미분석"으로 정직 표기.

import { inflateRawSync } from "node:zlib";
import * as CFB from "cfb";
import { strFromU8, unzipSync } from "fflate";
import { decodeEntities } from "./html.js";

const HWP_SIGNATURE = "HWP Document File";
const HWPTAG_PARA_TEXT = 67; // HWPTAG_BEGIN(16) + 51

export function looksLikeCfb(bytes: Buffer): boolean {
  return bytes.length > 8 && bytes.readUInt32LE(0) === 0xe011cfd0 && bytes.readUInt32LE(4) === 0xe11ab1a1;
}

export function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** BodyText 섹션 스트림 → 본문 텍스트 (레코드 워커) */
export function extractSectionText(section: Buffer): string {
  let out = "";
  let offset = 0;
  while (offset + 4 <= section.length) {
    const header = section.readUInt32LE(offset);
    offset += 4;
    const tag = header & 0x3ff;
    let size = (header >>> 20) & 0xfff;
    if (size === 0xfff) {
      if (offset + 4 > section.length) break;
      size = section.readUInt32LE(offset);
      offset += 4;
    }
    if (offset + size > section.length) break;

    if (tag === HWPTAG_PARA_TEXT) {
      const payload = section.subarray(offset, offset + size);
      for (let i = 0; i + 1 < payload.length; i += 2) {
        const code = payload.readUInt16LE(i);
        if (code >= 32) {
          out += String.fromCharCode(code);
        } else if (code === 10 || code === 13) {
          out += "\n";
        } else if ((code >= 1 && code <= 9) || code === 11 || code === 12 || (code >= 14 && code <= 23)) {
          // 인라인/확장 컨트롤은 컨트롤 문자 포함 8 WCHAR 를 차지한다
          i += 14;
        }
        // 0, 24~31: 단독 컨트롤 — 무시
      }
      out += "\n";
    }
    offset += size;
  }
  return out;
}

function cleanText(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hwpToText(bytes: Buffer): string {
  const container = CFB.read(bytes, { type: "buffer" });
  const headerEntry = CFB.find(container, "/FileHeader");
  if (!headerEntry?.content) throw new Error("HWP FileHeader 없음");
  const headerBuf = Buffer.from(headerEntry.content as Uint8Array);
  if (headerBuf.subarray(0, HWP_SIGNATURE.length).toString("latin1") !== HWP_SIGNATURE) {
    throw new Error("HWP 시그니처 불일치");
  }
  const flags = headerBuf.readUInt32LE(36);
  if (flags & 0b10) throw new Error("암호화된 HWP — 자동 추출 불가");
  if (flags & 0b100) throw new Error("배포용(DRM) HWP — 자동 추출 불가");
  const compressed = (flags & 1) === 1;

  const sections: { index: number; buf: Buffer }[] = [];
  container.FullPaths.forEach((path, i) => {
    const match = path.match(/BodyText\/Section(\d+)$/);
    if (!match) return;
    const entry = container.FileIndex[i];
    if (!entry?.content) return;
    sections.push({ index: Number(match[1]), buf: Buffer.from(entry.content as Uint8Array) });
  });
  if (sections.length === 0) throw new Error("HWP BodyText 섹션 없음");
  sections.sort((a, b) => a.index - b.index);

  let text = "";
  for (const section of sections) {
    const raw = compressed ? inflateRawSync(section.buf) : section.buf;
    text += `${extractSectionText(raw)}\n`;
  }
  return cleanText(text);
}

/** DOCX (OOXML) — word/document.xml 의 <w:t> 텍스트 노드 수집. HWPX 와 동일한 ZIP 패턴 */
export function docxToText(bytes: Buffer): string {
  const files = unzipSync(new Uint8Array(bytes));
  const doc = files["word/document.xml"];
  if (!doc) throw new Error("DOCX 본문 없음 (다른 ZIP 포맷)");
  const xml = strFromU8(doc);
  let out = "";
  for (const paragraph of xml.split(/<\/w:p>/)) {
    // run(w:r)이 단어 중간에서 쪼개지므로 <w:t>는 공백 없이 이어붙인다
    const texts = [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((match) => decodeEntities(match[1] ?? ""))
      .join("")
      .trim();
    if (texts) out += `${texts}\n`;
  }
  return cleanText(out);
}

export function hwpxToText(bytes: Buffer): string {
  const files = unzipSync(new Uint8Array(bytes));
  const sectionNames = Object.keys(files)
    .filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)?.[1] ?? 0) - Number(b.match(/(\d+)/)?.[1] ?? 0));
  if (sectionNames.length === 0) throw new Error("HWPX 섹션 없음 (다른 ZIP 포맷)");

  let out = "";
  for (const name of sectionNames) {
    const xml = strFromU8(files[name]!);
    // 문단(</hp:p>) 단위로 줄바꿈, 문단 안에서는 <hp:t> 텍스트 노드만 수집
    for (const paragraph of xml.split(/<\/hp:p>/)) {
      const texts = [...paragraph.matchAll(/<hp:t[^>]*>([\s\S]*?)<\/hp:t>/g)]
        .map((match) => decodeEntities(match[1] ?? ""))
        .join(" ")
        .trim();
      if (texts) out += `${texts}\n`;
    }
  }
  return cleanText(out);
}
