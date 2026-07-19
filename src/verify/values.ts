// 숫자·날짜 재대조 — 구조화된 값(마감일·지원금)이 근거 인용문에서 결정적으로 재도출되는지 검사.
// 인용은 진짜인데 값을 잘못 옮긴 경우(전사 오류)를 걸러내는 2차 방어선.

export interface ParsedDate {
  year: number | null;
  month: number;
  day: number;
}

export function parseKoreanDates(text: string): ParsedDate[] {
  const results: ParsedDate[] = [];
  const seen = new Set<string>();
  const push = (year: number | null, month: number, day: number) => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return;
    const key = `${year ?? "?"}-${month}-${day}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ year, month, day });
    }
  };

  // 2026-08-14 / 2026.8.14 / 2026년 8월 14일 / 2026/08/14
  for (const m of text.matchAll(/(\d{4})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/g)) {
    push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // '26. 8. 14
  for (const m of text.matchAll(/['']\s*(\d{2})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/g)) {
    push(2000 + Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // 8월 14일 (연도 없음)
  for (const m of text.matchAll(/(?<!\d[.\-\/년]\s?)(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) {
    push(null, Number(m[1]), Number(m[2]));
  }
  // 8. 14. (연도 없는 축약 — 앞에 4자리 연도가 붙지 않은 경우만)
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})\s*\.\s*(\d{1,2})\s*\.(?!\s*\d)/g)) {
    push(null, Number(m[1]), Number(m[2]));
  }
  return results;
}

/** ISO 날짜(YYYY-MM-DD)가 인용문 속 날짜들과 합치하는가 — 연도 없는 표기는 월·일만 대조 */
export function dateMatchesQuote(iso: string, quote: string): boolean {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return parseKoreanDates(quote).some(
    (candidate) =>
      candidate.month === month &&
      candidate.day === day &&
      (candidate.year === null || candidate.year === year),
  );
}

export function parseKrwAmounts(text: string): number[] {
  const amounts = new Set<number>();
  const cleaned = text.replace(/,/g, "");

  // 1억 / 1.5억 / 1억 5천만원 / 1억5000만원
  for (const m of cleaned.matchAll(/(\d+(?:\.\d+)?)\s*억(?:\s*(\d+(?:\.\d+)?)\s*(천만|백만|만))?\s*원?/g)) {
    const eok = parseFloat(m[1] ?? "0") * 100_000_000;
    let rest = 0;
    if (m[2] && m[3]) {
      const n = parseFloat(m[2]);
      rest = m[3] === "천만" ? n * 10_000_000 : m[3] === "백만" ? n * 1_000_000 : n * 10_000;
    }
    amounts.add(Math.round(eok + rest));
  }
  for (const m of cleaned.matchAll(/(\d+(?:\.\d+)?)\s*천만\s*원?/g)) {
    amounts.add(Math.round(parseFloat(m[1] ?? "0") * 10_000_000));
  }
  for (const m of cleaned.matchAll(/(\d+(?:\.\d+)?)\s*백만\s*원?/g)) {
    amounts.add(Math.round(parseFloat(m[1] ?? "0") * 1_000_000));
  }
  for (const m of cleaned.matchAll(/(\d+(?:\.\d+)?)\s*만\s*원/g)) {
    amounts.add(Math.round(parseFloat(m[1] ?? "0") * 10_000));
  }
  for (const m of cleaned.matchAll(/(\d{4,})\s*원/g)) {
    amounts.add(Number(m[1]));
  }
  return [...amounts];
}

export function amountMatchesQuote(valueKrw: number, quote: string): boolean {
  return parseKrwAmounts(quote).includes(valueKrw);
}
