# foundin

**1인 창업자를 위한 정부지원사업 판단 브리프 에이전트.** Upstage **Solar Open 2** 가 공고 원문과 첨부를
심사역처럼 정독하고, 자격·지원금·마감·서류·탈락 위험을 추출한 뒤, **모든 인용을 원문과 기계 대조**해
검증을 통과한 것만 "지원 전 판단 브리프"로 발행한다.

> founding(창업)에서 g 하나를 뺀 이름이자, found in(찾아냈다)이기도 하다.

[foundin.kr](https://foundin.kr) 의 분석 엔진이 이 저장소다. 프로덕션 편집국(워커)과 심사자가 실행하는
CLI 가 **완전히 같은 코드**를 쓴다.

## 빠른 시작

```bash
npm install
cp .env.example .env        # UPSTAGE_API_KEY 입력

# 아무 공고 URL 하나 분석 — 수집 → 판정 → 추출 → 원문 대조 검증 → 브리프
npm run analyze -- "https://www.k-startup.go.kr/...(공고 URL)"

# 내 조건(로컬 JSON)과 대조까지
npm run analyze -- "https://...(공고 URL)" --profile examples/profile.pre-seoul.json
```

여러 공고를 읽고 "오늘 확인해야 할 공고"로 정리하는 브리핑 모드:

```bash
cp urls.example.txt urls.txt   # 공고 URL 을 한 줄에 하나씩
npm run today -- --profile examples/profile.pre-seoul.json
```

오프라인 검증 (API 키 불필요):

```bash
npm test          # 검증기·수집기·매칭·오케스트레이터 (mock 러너 엔드투엔드)
npm run typecheck
```

## 왜 만들었나

정부지원사업 공고는 본문·첨부에 자격 요건이 흩어져 있고, 한 줄을 놓치면 서류를 다 쓰고 나서
탈락한다. LLM 요약은 이 문제를 해결하는 것 같지만, **환각 한 번이면 사용자가 잘못된 판단**을 한다.
그래서 이 에이전트는 "요약"이 아니라 **검증**을 중심에 놓았다.

## 어떻게 동작하나

```
공고 URL
  → ① 수집: 원문 HTML + PDF 첨부 (SSRF 가드, EUC-KR 대응. HWP 는 정직하게 "미분석" 표기)
  → ② 판정: 지원사업 공고인가? (아니면 사유와 함께 반려)
  → ③ 추출: 자격·제외·서류·일정·위험 + 모든 항목에 원문 인용 (Solar Open 2)
  → ④ 검증: 결정적 코드가 인용·날짜·금액을 원문과 대조 (LLM 아님)
       실패 인용은 피드백으로 되돌려 1회 재추출, 그래도 실패면 항목 보류
  → ⑤ 게이트: 핵심 필드(마감·자격) 검증 실패 시 브리프 전체 미발행 (fail-closed)
  → ⑥ 조언: 검증 통과 요건만으로 "처지별 분기 조언" 생성 (예비창업자라면 / 기창업자라면)
  → 판단 브리프 (JSON + Markdown)
```

설계 원칙 세 가지:

1. **오케스트레이션은 코드가 쥔다.** LLM 은 각 스텝의 추론만 담당한다. 베타 모델의 능력 편차에
   흔들리지 않고, tool calling 미지원이어도 동작한다.
2. **인용은 실존해야 발행된다.** `src/verify/` 가 모든 evidence quote 를 NFKC 정규화 후 원문에서
   substring 대조하고, 마감일·지원금은 인용문에서 값을 **재파싱해 재대조**한다. 지어낸 인용은
   기계적으로 걸러진다.
3. **프로필은 LLM 에 보내지 않는다.** 개인화(내 조건 대조)는 `src/match/` 의 결정적 규칙이 로컬에서
   수행한다. Solar 에는 공개 공고 원문만 전달된다. 대신 공고 쪽에서 "처지별 분기 조언"을 미리
   생성해두고 클라이언트가 자기 분기만 렌더한다 — 개인화 체감과 개인정보 비전송을 동시에 얻는다.

## 저장소 구조

```
src/
├── agent/        오케스트레이터 + 프롬프트 (판정 → 추출 → 조언)
├── verify/       결정적 검증기: 인용 대조 · 날짜/금액 재파싱 · 충돌 · 발행 게이트
├── collect/      SSRF 가드 fetch · HTML/PDF 텍스트 추출 · EUC-KR 디코드
├── llm/          러너 추상화: solar (베타) | claude-code | codex (구독 CLI 폴백)
├── match/        로컬 프로필 매칭 (LLM 비전송)
├── brief/        브리프 렌더러 (Markdown/터미널)
├── cli.ts        analyze · today
└── worker.ts     foundin.kr 편집국 큐 폴링 워커 (프로덕션 모드)
eval/calibrate.ts 모델 캘리브레이션 (JSON 준수율·장문·지연·tool calling 프로브)
fixtures/ test/   오프라인 픽스처와 테스트
```

## 프로덕션에서는

foundin.kr 에서 이 에이전트는 세 경로로 실행된다.

- 신규 수집 공고: 자동 브리프 생성 (편집국 워커가 큐 폴링)
- 기존 공고: "분석 요청" 투표 순서대로 처리
- 사용자가 가져온 외부 공고 URL: 게이트를 통과하면 공개 분석 페이지로 발행

Solar Open 2 베타 종료(2026-08-01) 후에는 러너를 `claude-code` / `codex` (구독 CLI, OAuth) 로
전환해 같은 파이프라인이 계속 돈다 (`FOUNDIN_RUNNER` 환경변수 하나).

## Solar Open 2 (Stage 1)

| 항목 | 값 |
| --- | --- |
| 모델 | `solar-open2` (Upstage Private Beta, 2026-07-17 ~ 07-31) |
| Rate Limit | 400 RPM / 150,000 TPM |
| Console | https://console.upstage.ai |

API 키는 `.env` 로만 관리한다. 커밋 금지.

## 로드맵

- 마감 일정 관리 · 지원사업 간 자격 충돌 확인 · 사업계획서 작성 체크리스트 자동화
- HWP/HWPX 첨부 텍스트 추출 (현재는 미분석 항목으로 정직하게 표기)
- 브리프 정확도 평가 코퍼스 공개 (골든셋 대비 필드 정확도·인용 통과율)

## 참고

- Upstage Solar Agent Partner Program Stage 1 (2026-07-17 ~ 07-31) 참여작
- 모든 브리프는 **참고용**이며 최종 확인은 공고 원문에서 해야 한다. 브리프에는 항상 원문 링크가 포함된다.
