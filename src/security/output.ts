const UNSAFE_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const DANGEROUS_SCHEME = /\b(javascript|vbscript|data)\s*:/gi;

/**
 * LLM·외부 문서 유래 문자열을 HTML/Markdown으로 다시 해석할 수 없게 만든다.
 * 표시 가능한 전각 문자를 사용해 내용은 보존하면서 태그와 링크 문법만 끊는다.
 */
export function sanitizePublicationText(text: string): string {
  return text
    .replace(UNSAFE_CONTROL_CHARS, "")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］")
    .replace(DANGEROUS_SCHEME, (_match, scheme: string) => `${scheme}：`);
}

/** 게시되는 구조 전체에 동일한 문자열 경계를 적용한다. */
export function sanitizePublicationValue<T>(value: T, key?: string): T {
  if (typeof value === "string") {
    // URL은 수집·스키마 경계에서 HTTP(S)로 검증되며, IPv6의 대괄호 등 URL 문법을 보존해야 한다.
    if (key === "url" || key === "source_url") return value;
    return sanitizePublicationText(value) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizePublicationValue(entry, key)) as T;
  if (value && typeof value === "object") {
    const sanitized = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
        entryKey,
        sanitizePublicationValue(entry, entryKey),
      ]),
    );
    return sanitized as T;
  }
  return value;
}
