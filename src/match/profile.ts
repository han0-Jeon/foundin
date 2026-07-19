import { z } from "zod";
import type { Brief, EligibilityFacts } from "../types.js";

// 로컬 프로필 매칭 — 프로필은 LLM 으로 절대 전송되지 않는다.
// Solar 가 추출·검증한 구조화 팩트와 프로필을 결정적 규칙으로만 대조한다.
// (foundin.kr lib/eligibility/evaluate.ts 의 경량판)

export const profileSchema = z.object({
  /** pre=예비, early=1년 미만, growth=1~3년, stable=3년+ */
  biz_stage: z.enum(["pre", "early", "growth", "stable"]).nullable().default(null),
  regions: z.array(z.string()).default([]),
  age: z.number().int().min(10).max(99).nullable().default(null),
  has_biz_reg: z.boolean().nullable().default(null),
  industries: z.array(z.string()).default([]),
});
export type Profile = z.infer<typeof profileSchema>;

export type CheckStatus = "ok" | "no" | "unknown";
export interface ProfileCheck {
  key: "deadline" | "stage" | "region" | "age" | "biz_reg" | "excluded";
  label: string;
  status: CheckStatus;
  detail?: string;
}
export interface MatchResult {
  status: "eligible" | "needs_review" | "ineligible";
  checks: ProfileCheck[];
  /** 미충족이지만 해소 가능성이 있는 항목의 세그먼트 키 (분기 조언 렌더용) */
  segment: "pre_startup" | "registered";
}

function stageYearsRange(stage: Profile["biz_stage"]): { min: number; max: number } | null {
  switch (stage) {
    case "early":
      return { min: 0, max: 1 };
    case "growth":
      return { min: 1, max: 3 };
    case "stable":
      return { min: 3, max: Number.POSITIVE_INFINITY };
    default:
      return null;
  }
}

function norm(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

export function matchProfile(brief: Brief, profile: Profile, now = new Date()): MatchResult {
  const facts: EligibilityFacts = brief.eligibility;
  const checks: ProfileCheck[] = [];

  // 마감
  if (brief.overview.apply_end) {
    const end = new Date(`${brief.overview.apply_end}T23:59:59+09:00`);
    checks.push(
      end.getTime() >= now.getTime()
        ? { key: "deadline", label: "접수 기간", status: "ok", detail: `${brief.overview.apply_end} 마감` }
        : { key: "deadline", label: "접수 기간", status: "no", detail: "마감됨" },
    );
  }

  // 창업 단계·업력
  if (profile.biz_stage === "pre") {
    if (facts.excludes_pre_startup === true) {
      checks.push({ key: "stage", label: "예비창업 가능 여부", status: "no", detail: "예비창업자 제외 공고" });
    } else if (facts.requires_business_registration === true && facts.allows_pre_startup !== true) {
      checks.push({ key: "biz_reg", label: "사업자등록", status: "no", detail: "사업자등록 필요" });
    } else if (facts.allows_pre_startup === true) {
      checks.push({ key: "stage", label: "예비창업 가능 여부", status: "ok" });
    } else if (facts.min_startup_years !== null || facts.max_startup_years !== null) {
      checks.push({ key: "stage", label: "업력 요건", status: "no", detail: "기창업 기업 대상" });
    } else {
      checks.push({ key: "stage", label: "예비창업 가능 여부", status: "unknown", detail: "공고에 명시 없음" });
    }
  } else if (profile.biz_stage) {
    const userRange = stageYearsRange(profile.biz_stage);
    if (userRange && (facts.min_startup_years !== null || facts.max_startup_years !== null)) {
      const required = { min: facts.min_startup_years ?? 0, max: facts.max_startup_years ?? Number.POSITIVE_INFINITY };
      const overlap = userRange.min <= required.max && required.min <= userRange.max;
      checks.push({
        key: "stage",
        label: "업력 요건",
        status: overlap ? "ok" : "no",
        detail: `공고 기준 ${facts.min_startup_years ?? 0}~${facts.max_startup_years ?? "∞"}년`,
      });
    }
    if (profile.has_biz_reg === false && facts.requires_business_registration === true) {
      checks.push({ key: "biz_reg", label: "사업자등록", status: "no", detail: "사업자등록 필요" });
    }
  }

  // 지역
  if (facts.target_regions.length > 0) {
    const targets = facts.target_regions.map(norm);
    if (targets.some((region) => region.includes("전국"))) {
      checks.push({ key: "region", label: "지역", status: "ok", detail: "전국" });
    } else if (profile.regions.length === 0) {
      checks.push({ key: "region", label: "지역", status: "unknown", detail: facts.target_regions.join(", ") });
    } else {
      const mine = profile.regions.map(norm);
      const hit = mine.some((userRegion) => targets.some((target) => target.includes(userRegion) || userRegion.includes(target)));
      checks.push({
        key: "region",
        label: "지역",
        status: hit ? "ok" : "no",
        detail: facts.target_regions.join(", "),
      });
    }
  }

  // 연령
  if (facts.min_age !== null || facts.max_age !== null) {
    if (profile.age === null) {
      checks.push({ key: "age", label: "연령", status: "unknown", detail: `공고 기준 만 ${facts.min_age ?? 0}~${facts.max_age ?? "∞"}세` });
    } else {
      const ok = profile.age >= (facts.min_age ?? 0) && profile.age <= (facts.max_age ?? 999);
      checks.push({ key: "age", label: "연령", status: ok ? "ok" : "no", detail: `공고 기준 만 ${facts.min_age ?? 0}~${facts.max_age ?? "∞"}세` });
    }
  }

  // 명시적 제외 대상
  for (const target of facts.excluded_targets) {
    const text = norm(target);
    if (profile.biz_stage === "pre" && /(예비창업|미창업|창업예정|사업자등록전)/.test(text)) {
      checks.push({ key: "excluded", label: "제외 대상", status: "no", detail: target });
      break;
    }
  }

  const hasNo = checks.some((check) => check.status === "no");
  const hasUnknown = checks.some((check) => check.status === "unknown");
  return {
    status: hasNo ? "ineligible" : hasUnknown ? "needs_review" : "eligible",
    checks,
    segment: profile.biz_stage === "pre" || profile.has_biz_reg === false ? "pre_startup" : "registered",
  };
}
