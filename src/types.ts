import { z } from "zod";

// ── 근거 인용 ────────────────────────────────────────────────
// quote 는 원문에서 "그대로 복사"돼야 하며, 검증기가 원문 대조에 실패하면 해당 항목은 보류된다.
export const evidenceSchema = z.object({
  quote: z.string().min(4).max(400),
  source_url: z.string().url(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

// ── 자격 팩트 (foundin.kr program_eligibility_facts 와 호환 형태) ──
export const eligibilityFactsSchema = z.object({
  allows_pre_startup: z.boolean().nullable(),
  excludes_pre_startup: z.boolean().nullable(),
  requires_business_registration: z.boolean().nullable(),
  min_startup_years: z.number().min(0).nullable(),
  max_startup_years: z.number().min(0).nullable(),
  min_age: z.number().int().min(0).nullable(),
  max_age: z.number().int().min(0).nullable(),
  max_revenue_krw: z.number().int().min(0).nullable(),
  max_employees: z.number().int().min(0).nullable(),
  target_regions: z.array(z.string().min(1).max(50)).max(30).default([]),
  required_certifications: z.array(z.string().min(1).max(80)).max(30).default([]),
  excluded_targets: z.array(z.string().min(1).max(120)).max(30).default([]),
});
export type EligibilityFacts = z.infer<typeof eligibilityFactsSchema>;

// ── 공고 개요 ────────────────────────────────────────────────
export const overviewSchema = z.object({
  title: z.string().min(2).max(200),
  organizer: z.string().max(120).nullable(),
  apply_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  apply_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  apply_end_time: z.string().max(20).nullable(),
  amount_max_krw: z.number().int().min(0).nullable(),
  amount_note: z.string().max(200).nullable(),
  support_scale: z.string().max(120).nullable(),
  self_funding_note: z.string().max(200).nullable(),
});
export type Overview = z.infer<typeof overviewSchema>;

// ── 분기형 조언 세그먼트 ─────────────────────────────────────
// 프로필을 LLM 에 보내는 대신, 공고 쪽에서 갈래별 조언을 미리 생성해두고
// 클라이언트가 자기 분기만 렌더한다 (개인화 + PII 비전송 동시 달성).
export const adviceSegments = ["pre_startup", "registered", "general"] as const;
export const branchAdviceSchema = z
  .record(z.enum(adviceSegments), z.string().min(2).max(600))
  .nullable()
  .default(null);

const requirementSchema = z.object({
  text: z.string().min(2).max(200),
  evidence: evidenceSchema,
  branch_advice: branchAdviceSchema,
});
const itemSchema = z.object({
  text: z.string().min(2).max(300),
  evidence: evidenceSchema.nullable().default(null),
});
const documentItemSchema = z.object({
  name: z.string().min(1).max(120),
  note: z.string().max(200).nullable().default(null),
  evidence: evidenceSchema.nullable().default(null),
});
const scheduleItemSchema = z.object({
  label: z.string().min(1).max(60),
  date_text: z.string().min(1).max(80),
  evidence: evidenceSchema.nullable().default(null),
});

// overview 숫자·날짜 필드의 근거 인용 (field 명 ↔ overview 키)
const overviewEvidenceSchema = z.object({
  field: z.string().min(1).max(60),
  quote: z.string().min(4).max(400),
  source_url: z.string().url(),
});

// ── LLM 스텝 1: 공고 판정 ────────────────────────────────────
export const classificationSchema = z.object({
  is_program: z.boolean(),
  reason: z.string().max(300),
  title: z.string().max(200).nullable(),
  organizer: z.string().max(120).nullable(),
});
export type Classification = z.infer<typeof classificationSchema>;

// ── LLM 스텝 2: 구조화 추출 ──────────────────────────────────
export const extractionSchema = z.object({
  overview: overviewSchema,
  overview_evidence: z.array(overviewEvidenceSchema).max(20).default([]),
  eligibility: eligibilityFactsSchema,
  requirements: z.array(requirementSchema).max(12),
  exclusions: z.array(itemSchema).max(12).default([]),
  documents: z.array(documentItemSchema).max(15).default([]),
  schedule: z.array(scheduleItemSchema).max(10).default([]),
  risk_points: z.array(itemSchema).max(10).default([]),
  confidence: z.number().min(0).max(1),
  notes: z.string().max(500).nullable().default(null),
});
export type Extraction = z.infer<typeof extractionSchema>;

// ── LLM 스텝 3: 판단 조언 (검증 통과 항목만 입력으로 받음) ────
export const adviceSchema = z.object({
  why_look: z.string().min(10).max(700),
  requirement_advice: z
    .array(
      z.object({
        index: z.number().int().min(0),
        branch_advice: z.record(z.enum(adviceSegments), z.string().min(2).max(600)),
      }),
    )
    .max(12)
    .default([]),
});
export type Advice = z.infer<typeof adviceSchema>;

// ── 수집 문서 ────────────────────────────────────────────────
export interface SourceDocument {
  url: string;
  kind: "html" | "pdf" | "hwp" | "hwpx" | "text";
  title: string | null;
  text: string;
}
export interface SkippedAttachment {
  url: string;
  kind: string; // hwp | hwpx | too_large | fetch_failed ...
  fileName: string | null;
}

// ── 검증 리포트 (결정적 계산, LLM 산출물 아님) ────────────────
export interface VerificationReport {
  quotes_total: number;
  quotes_passed: number;
  /** 인용 대조 실패로 보류된 항목 위치 (예: "requirements[1]", "overview.amount_max_krw") */
  held: string[];
  /** 숫자·날짜가 인용문과 불일치한 항목 */
  value_issues: string[];
  /** 문서 간 충돌 (예: 마감일 상이) */
  conflicts: string[];
  publishable: boolean;
  gate_reason: string | null;
}

// ── 최종 브리프 ──────────────────────────────────────────────
export interface VerifiedItem<T> {
  verified: boolean;
  item: T;
}
export interface Brief {
  source_url: string;
  analyzed_at: string; // ISO
  model: string;
  overview: Overview;
  eligibility: EligibilityFacts;
  why_look: string | null;
  requirements: VerifiedItem<z.infer<typeof requirementSchema>>[];
  exclusions: VerifiedItem<z.infer<typeof itemSchema>>[];
  documents: VerifiedItem<z.infer<typeof documentItemSchema>>[];
  schedule: VerifiedItem<z.infer<typeof scheduleItemSchema>>[];
  risk_points: VerifiedItem<z.infer<typeof itemSchema>>[];
  verification: VerificationReport;
  documents_meta: { url: string; kind: string; chars: number }[];
  skipped_attachments: SkippedAttachment[];
  confidence: number;
}

export type AnalysisResult =
  | { ok: true; brief: Brief }
  | {
      ok: false;
      stage: "collect" | "classify" | "extract" | "verify";
      reason: string;
      /** classify 단계에서 공고가 아니라고 판정된 경우 */
      not_a_program?: boolean;
      source_url: string;
    };
