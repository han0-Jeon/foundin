// 1회용 원시 응답 프로브 — solar-open2 의 응답 형태 확인
import { loadDotEnv } from "../src/env.js";

loadDotEnv();

const response = await fetch(`${process.env.UPSTAGE_BASE_URL}/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.UPSTAGE_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: process.env.UPSTAGE_MODEL,
    messages: [{ role: "user", content: "1+1은? 숫자만 답해." }],
    max_tokens: 2000,
  }),
  signal: AbortSignal.timeout(120_000),
});

console.log("HTTP", response.status);
const data = (await response.json()) as {
  choices?: { message?: Record<string, unknown>; finish_reason?: string }[];
  usage?: unknown;
  error?: unknown;
};
if (data.error) console.log("error:", JSON.stringify(data.error).slice(0, 300));
const message = data.choices?.[0]?.message ?? {};
console.log("message keys:", Object.keys(message));
console.log("content:", JSON.stringify(message.content)?.slice(0, 300));
console.log("reasoning_content:", JSON.stringify((message as { reasoning_content?: unknown }).reasoning_content)?.slice(0, 300));
console.log("finish_reason:", data.choices?.[0]?.finish_reason, "| usage:", JSON.stringify(data.usage));
