import type { SourceDocument } from "../types.js";

// 프롬프트 설계 원칙
// - 오케스트레이션(순서·재시도·검증)은 코드가 쥔다. LLM 은 각 스텝의 추론만 담당.
// - 인용은 "원문에서 글자 그대로 복사"를 반복 강조 — 검증기가 실존 여부를 대조하므로
//   지어낸 인용은 곧 보류·미발행로 이어진다 (fail-closed).

export const CLASSIFY_SYSTEM = `너는 한국 정부·지자체·공공기관의 지원사업 공고를 감별하는 심사역이다.
주어진 웹페이지 텍스트가 "개인·기업이 신청할 수 있는 지원사업 공고"인지 판정한다.
뉴스 기사, 블로그 후기, 사업 소개 페이지, 선정 결과 발표, 채용 공고는 공고가 아니다.
JSON 만 출력한다. 마크다운 펜스 금지.

출력 형식:
{"is_program": boolean, "reason": "판정 근거 한두 문장", "title": "공고 제목"|null, "organizer": "주관기관"|null}`;

export const EXTRACT_SYSTEM = `너는 한국 정부지원사업 공고를 정독하고 구조화하는 심사역이다.
아래 문서들에서 사실만 추출한다. 규칙:

1. 문서에 명시된 사실만 추출한다. 추측·일반 상식으로 채우지 않는다. 불명확하면 null.
2. 모든 evidence.quote 는 문서 원문에서 **글자 그대로 복사**한다 (10~200자). 요약·의역·재구성 금지.
   quote 가 원문에 실존하는지 기계 검증되며, 불일치 항목은 폐기된다.
3. requirements 는 "신청 자격 요건"만 (우대·가점 제외). 각 항목에 evidence 필수.
4. exclusions 는 명시적 신청 제외 대상만.
5. documents 는 제출 서류. schedule 은 접수·평가·발표 등 일정.
6. risk_points 는 문서에 명시된 감점·무효·유의사항 (예: 양식 미준수 무효, 자부담 비율, 마감 시각).
   문서에 없는 일반론적 조언은 넣지 않는다.
7. eligibility 숫자 필드: 업력은 년 단위 숫자, 금액은 원 단위 정수. 연령은 만 나이.
8. required_certifications 는 필수 요건일 때만. 우대 사항은 제외.
9. overview_evidence 에는 apply_start, apply_end, amount_max_krw, support_scale 값 각각의 근거 인용을 넣는다 (field 명 일치).
10. 날짜는 YYYY-MM-DD. 연도가 문서에 없으면 접수 맥락상 가장 타당한 연도를 쓰되 confidence 를 낮춘다.

JSON 만 출력한다. 형식:
{
  "overview": {"title": str, "organizer": str|null, "apply_start": "YYYY-MM-DD"|null, "apply_end": "YYYY-MM-DD"|null,
    "apply_end_time": str|null, "amount_max_krw": int|null, "amount_note": str|null, "support_scale": str|null, "self_funding_note": str|null},
  "overview_evidence": [{"field": str, "quote": str, "source_url": str}],
  "eligibility": {"allows_pre_startup": bool|null, "excludes_pre_startup": bool|null, "requires_business_registration": bool|null,
    "min_startup_years": num|null, "max_startup_years": num|null, "min_age": int|null, "max_age": int|null,
    "max_revenue_krw": int|null, "max_employees": int|null, "target_regions": [str], "required_certifications": [str], "excluded_targets": [str]},
  "requirements": [{"text": str, "evidence": {"quote": str, "source_url": str}, "branch_advice": null}],
  "exclusions": [{"text": str, "evidence": {"quote": str, "source_url": str}|null}],
  "documents": [{"name": str, "note": str|null, "evidence": {"quote": str, "source_url": str}|null}],
  "schedule": [{"label": str, "date_text": str, "evidence": {"quote": str, "source_url": str}|null}],
  "risk_points": [{"text": str, "evidence": {"quote": str, "source_url": str}|null}],
  "confidence": 0~1,
  "notes": str|null
}`;

export const ADVISE_SYSTEM = `너는 정부지원사업 심사역이다. 검증이 끝난 자격 요건 목록을 보고,
지원 여부를 고민하는 1인 창업자를 위해 짧은 판단 코멘트를 쓴다.

규칙:
1. why_look: 이 공고를 왜 볼 만한지 3~4문장. 과장 금지, 건조하게. 지원금·대상·마감 여유 중심.
2. requirement_advice: 요건별로, 처지에 따라 대응이 갈리는 경우에만 분기 조언을 쓴다.
   - "pre_startup": 예비창업자(사업자등록 전)에게 이 요건이 갖는 의미·해소 방법
   - "registered": 기창업자에게 갖는 의미
   - "general": 처지 무관 공통 확인 방법
   각 조언은 1~2문장. 요건 텍스트에 없는 새로운 사실(금액·날짜·조건)을 만들어내지 않는다.
   해소 불가능한 요건이면 솔직하게 불가능하다고 쓴다.
3. 분기가 무의미한 요건(예: 지역 요건)은 advice 를 만들지 않는다.

JSON 만 출력한다. 형식:
{"why_look": str, "requirement_advice": [{"index": int, "branch_advice": {"pre_startup": str, "registered": str, "general": str}}]}
(branch_advice 키는 필요한 세그먼트만 포함)`;

const PER_DOC_CAP = 14_000;
const TOTAL_CAP = 26_000;

export function renderDocuments(documents: SourceDocument[]): string {
  let budget = TOTAL_CAP;
  const parts: string[] = [];
  documents.forEach((document, index) => {
    if (budget <= 500) return;
    const slice = document.text.slice(0, Math.min(PER_DOC_CAP, budget));
    budget -= slice.length;
    parts.push(
      `[문서 ${index + 1}] (${document.kind}) ${document.title ?? ""}\nsource_url: ${document.url}\n---\n${slice}`,
    );
  });
  return parts.join("\n\n");
}

export function classifyUser(documents: SourceDocument[]): string {
  const main = documents[0];
  const text = main ? main.text.slice(0, 6_000) : "";
  return `다음 페이지가 지원사업 공고인지 판정하라.\n\nurl: ${main?.url ?? ""}\n페이지 제목: ${main?.title ?? "없음"}\n\n본문:\n${text}`;
}

export function extractUser(documents: SourceDocument[], feedback?: string): string {
  const base = `다음 공고 문서들에서 구조화 추출을 수행하라.\n\n${renderDocuments(documents)}`;
  if (!feedback) return base;
  return `${base}\n\n[재시도 피드백]\n${feedback}\n피드백을 반영해 전체 JSON 을 다시 출력하라. 검증에 실패한 인용은 원문에서 다시 정확히 복사하거나, 해당 항목을 제거하라.`;
}

export function adviseUser(input: {
  title: string;
  requirements: { index: number; text: string }[];
  overviewSummary: string;
}): string {
  const list = input.requirements.map((r) => `${r.index}. ${r.text}`).join("\n");
  return `공고: ${input.title}\n개요: ${input.overviewSummary}\n\n검증된 자격 요건:\n${list}\n\nwhy_look 과 requirement_advice 를 작성하라. index 는 위 번호를 그대로 사용한다.`;
}
