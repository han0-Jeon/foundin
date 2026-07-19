// 기관 문의 질문 자동 생성 (2026-07-19 결정) — 결정적 코드, Solar 호출 없음.
// fail-closed 검증이 만든 정보 공백(보류 항목·미검증 값·읽지 못한 첨부)을
// "기관에 이렇게 확인하세요" 질문으로 뒤집는다. 환각 위험 0 (추출·검증 결과에서만 기계 생성).

import type { Brief, InquiryQuestion } from "../types.js";

const MAX_QUESTIONS = 8;
const MAX_PER_SECTION = 3;

function truncate(text: string, max = 80): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/**
 * 브리프의 불확실 지점에서 문의 질문을 생성한다 (마감 > 금액 > 충돌 > 자격 > 서류 > 첨부 순).
 * 인자는 조립 완료 직전의 브리프 (inquiry_questions 제외 전부 채워진 상태).
 */
export function buildInquiryQuestions(brief: Omit<Brief, "inquiry_questions">): InquiryQuestion[] {
  const questions: InquiryQuestion[] = [];
  const heldSet = new Set(brief.verification.held);

  // 1. 접수 마감 — 값이 없거나, 있어도 원문 검증에 실패한 경우
  if (!brief.overview.apply_end) {
    questions.push({
      topic: "접수 마감",
      question: "접수 마감일시가 공고문에서 확정되지 않았습니다. 정확한 마감 일자와 시각을 확인하세요.",
    });
  } else if (heldSet.has("overview.apply_end")) {
    questions.push({
      topic: "접수 마감",
      question: `접수 마감이 "${brief.overview.apply_end}"로 추출됐지만 원문 대조에 실패했습니다. 정확한 마감 일시를 확인하세요.`,
    });
  }

  // 2. 지원 금액
  if (brief.overview.amount_max_krw === null && !brief.overview.amount_note && !brief.overview.support_scale) {
    questions.push({
      topic: "지원 금액",
      question: "지원 금액·규모가 공고문에서 확인되지 않았습니다. 지원 한도와 자부담 비율을 확인하세요.",
    });
  } else if (heldSet.has("overview.amount_max_krw")) {
    questions.push({
      topic: "지원 금액",
      question: "추출된 지원 금액이 원문 대조에 실패했습니다. 정확한 지원 한도를 확인하세요.",
    });
  }

  // 3. 문서 간 충돌 — 본문·첨부 값 불일치 (첨부 우선 채택했지만 확인 권장)
  for (const conflict of brief.verification.conflicts.slice(0, 2)) {
    questions.push({
      topic: "문서 간 충돌",
      question: `본문과 첨부의 내용이 서로 다릅니다 (${truncate(conflict)}). 어느 쪽이 맞는지 확인하세요.`,
    });
  }

  // 4. 보류된 자격 요건 — 원문 대조 실패로 확신하지 못한 항목
  let heldReq = 0;
  for (const { verified, item } of brief.requirements) {
    if (verified || heldReq >= MAX_PER_SECTION) continue;
    heldReq++;
    questions.push({
      topic: "자격 요건",
      question: `"${truncate(item.text)}" 요건을 원문에서 검증하지 못했습니다. 해당 기준의 정확한 내용을 확인하세요.`,
    });
  }

  // 5. 보류된 제출 서류
  let heldDoc = 0;
  for (const { verified, item } of brief.documents) {
    if (verified || heldDoc >= 2) continue;
    heldDoc++;
    questions.push({
      topic: "제출 서류",
      question: `"${truncate(item.name, 60)}" 서류가 실제 필수인지 원문에서 검증하지 못했습니다. 제출 대상 여부를 확인하세요.`,
    });
  }

  // 6. 읽지 못한 첨부 — 암호화 HWP·다운로드 실패 등
  for (const skipped of brief.skipped_attachments.slice(0, 2)) {
    const name = skipped.fileName ?? "첨부파일";
    questions.push({
      topic: "미확인 첨부",
      question: `"${truncate(name, 60)}" 첨부를 자동으로 읽지 못했습니다 (${truncate(skipped.kind, 30)}). 자격·서류 관련 내용이 있는지 원문에서 확인하세요.`,
    });
  }

  return questions.slice(0, MAX_QUESTIONS);
}
