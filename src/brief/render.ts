import type { Brief } from "../types.js";
import type { MatchResult, Profile } from "../match/profile.js";

// 브리프 렌더러 — Markdown(파일 저장·발행용)과 터미널 출력을 겸한다.

const STATUS_LABEL: Record<string, string> = {
  eligible: "지원 가능성 높음",
  needs_review: "확인 필요 항목 있음",
  ineligible: "현재 조건으로는 지원 불가",
};

function money(krw: number | null): string | null {
  if (krw === null) return null;
  if (krw >= 100_000_000) {
    const eok = krw / 100_000_000;
    return Number.isInteger(eok) ? `${eok}억원` : `${eok.toFixed(1)}억원`;
  }
  return `${Math.round(krw / 10_000).toLocaleString()}만원`;
}

function mark(verified: boolean): string {
  return verified ? "" : " ⚠(원문 확인 필요)";
}

export function renderMarkdown(brief: Brief, match?: { profile: Profile; result: MatchResult }): string {
  const lines: string[] = [];
  const o = brief.overview;

  lines.push(`# ${o.title}`);
  lines.push("");
  if (match) {
    lines.push(`> **내 기준 판정: ${STATUS_LABEL[match.result.status]}**`);
    for (const check of match.result.checks) {
      const icon = check.status === "ok" ? "✓" : check.status === "no" ? "✗" : "?";
      lines.push(`> - ${icon} ${check.label}${check.detail ? ` — ${check.detail}` : ""}`);
    }
    lines.push("");
  }

  const factParts = [
    o.organizer ? `주관: ${o.organizer}` : null,
    money(o.amount_max_krw) ? `지원금: 최대 ${money(o.amount_max_krw)}` : o.amount_note,
    o.support_scale ? `규모: ${o.support_scale}` : null,
    o.apply_end ? `마감: ${o.apply_end}${o.apply_end_time ? ` ${o.apply_end_time}` : ""}` : "마감: 공고 확인",
    o.self_funding_note ? `자부담: ${o.self_funding_note}` : null,
  ].filter(Boolean);
  lines.push(factParts.map((part) => `**${part}**`).join(" · "));
  lines.push("");

  if (brief.why_look) {
    lines.push(`## 볼 이유`);
    lines.push(brief.why_look);
    lines.push("");
  }

  lines.push(`## 자격 요건`);
  for (const { item, verified } of brief.requirements) {
    lines.push(`- ${item.text}${mark(verified)}`);
    if (verified) lines.push(`  > "${item.evidence.quote}"`);
    if (item.branch_advice) {
      for (const [segment, advice] of Object.entries(item.branch_advice)) {
        const label = segment === "pre_startup" ? "예비창업자라면" : segment === "registered" ? "기창업자라면" : "공통";
        lines.push(`  - ↳ ${label}: ${advice}`);
      }
    }
  }
  lines.push("");

  if (brief.exclusions.length > 0) {
    lines.push(`## 제외 대상`);
    for (const { item, verified } of brief.exclusions) lines.push(`- ${item.text}${mark(verified)}`);
    lines.push("");
  }
  if (brief.documents.length > 0) {
    lines.push(`## 필요 서류`);
    for (const { item, verified } of brief.documents) {
      lines.push(`- [ ] ${item.name}${item.note ? ` — ${item.note}` : ""}${mark(verified)}`);
    }
    lines.push("");
  }
  if (brief.schedule.length > 0) {
    lines.push(`## 일정`);
    for (const { item, verified } of brief.schedule) lines.push(`- ${item.label}: ${item.date_text}${mark(verified)}`);
    lines.push("");
  }
  if (brief.risk_points.length > 0) {
    lines.push(`## 탈락·감점 위험`);
    for (const { item, verified } of brief.risk_points) lines.push(`- ${item.text}${mark(verified)}`);
    lines.push("");
  }
  if (brief.contact && (brief.contact.phones.length > 0 || brief.contact.emails.length > 0)) {
    lines.push(`## 문의처`);
    if (brief.contact.phones.length > 0) lines.push(`- 전화: ${brief.contact.phones.join(", ")}`);
    if (brief.contact.emails.length > 0) lines.push(`- 이메일: ${brief.contact.emails.join(", ")}`);
    lines.push("");
  }

  if (brief.skipped_attachments.length > 0) {
    lines.push(`## 자동 분석하지 못한 첨부`);
    for (const skipped of brief.skipped_attachments) {
      lines.push(`- ${skipped.fileName ?? skipped.url} (${skipped.kind}) — 원문에서 직접 확인 필요`);
    }
    lines.push("");
  }

  const v = brief.verification;
  lines.push("---");
  lines.push(
    `생성: ${brief.model} · ${brief.analyzed_at.slice(0, 10)} · 인용 검증 ${v.quotes_passed}/${v.quotes_total} 통과` +
      (v.held.length > 0 ? ` · 보류 ${v.held.length}건` : ""),
  );
  lines.push(`본 브리프는 **참고용**입니다. 최종 확인은 반드시 공고 원문에서 하세요: ${brief.source_url}`);
  return lines.join("\n");
}

export function renderTerminal(brief: Brief, match?: { profile: Profile; result: MatchResult }): string {
  // 터미널은 Markdown 을 그대로 쓰되 헤더만 구분선으로 강조
  return renderMarkdown(brief, match)
    .replace(/^# (.+)$/m, (_, title: string) => `\n━━━ ${title} ━━━`)
    .replace(/^## (.+)$/gm, (_, title: string) => `\n■ ${title}`)
    .replace(/^> /gm, "  ");
}
