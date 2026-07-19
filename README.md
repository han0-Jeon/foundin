# foundin

**1인 창업자를 위한 정부지원사업 판단 브리프 에이전트입니다.** Upstage **Solar Open 2**가 공고 원문과
첨부를 심사역처럼 정독하고 자격·지원금·마감·서류·탈락 위험을 추출하면, 코드가 **모든 인용을 원문과
기계 대조**합니다. 검증을 통과한 것만 "지원 전 판단 브리프"로 발행합니다.

> founding(창업)에서 g 하나를 뺀 이름이고, found in(찾아냈다)이기도 합니다.

[foundin.kr](https://foundin.kr)의 분석 엔진이 이 저장소입니다. 프로덕션 워커와 심사자가 실행하는
CLI가 완전히 같은 코드를 씁니다.

## 빠른 시작

```bash
npm install
cp .env.example .env        # UPSTAGE_API_KEY 입력

# 공고 URL 하나 분석 — 수집 → 판정 → 추출 → 원문 대조 검증 → 브리프
npm run analyze -- "https://www.k-startup.go.kr/...(공고 URL)"

# 내 조건(로컬 JSON)과 대조까지
npm run analyze -- "https://...(공고 URL)" --profile examples/profile.pre-seoul.json
```

여러 공고를 읽고 "오늘 확인해야 할 공고"로 정리하는 브리핑 모드도 있습니다.

```bash
cp urls.example.txt urls.txt   # 공고 URL 을 한 줄에 하나씩
npm run today -- --profile examples/profile.pre-seoul.json
```

API 키 없이 오프라인으로 검증만 돌려볼 수도 있습니다.

```bash
npm test          # 검증기·수집기·매칭·오케스트레이터 (mock 러너 엔드투엔드)
npm run typecheck
```

## 왜 만들었나

정부지원사업 공고는 본문과 첨부에 자격 요건이 흩어져 있어서, 한 줄을 놓치면 서류를 다 쓰고 나서
탈락하게 됩니다. LLM 요약이 이 문제를 해결해줄 것 같지만, 환각이 한 번 섞이면 사용자가 잘못된
판단을 내립니다. 그래서 이 에이전트는 "요약"이 아니라 **검증**을 중심에 놓았습니다.

## 어떻게 동작하나

```
공고 URL
  → ① 수집: 원문 HTML + PDF·HWP·HWPX·DOCX 첨부 (SSRF 가드, EUC-KR 대응. 암호화·DRM 문서만 "미분석" 표기)
  → ①.5 프리체크: 출처 도메인 티어(공공 *.go.kr·화이트리스트 / 일반 / 반려) + 위험신호(선입금·계좌
       송금·주민번호·텔레그램 유도) + 공고 패턴 — 결정적 코드. 공공+공고면 즉시 통과(판정 생략),
       IP·punycode·유사도메인·신생 도메인·위험신호면 즉시 반려
  → ② 판정: (프리체크가 애매할 때만) 지원사업 공고인가? (아니면 사유와 함께 반려)
  → ③ 추출: 자격·제외·서류·일정·위험 + 모든 항목에 원문 인용 (Solar Open 2)
  → ④ 검증: 결정적 코드가 인용·날짜·금액을 원문과 대조 (LLM 아님)
       실패 인용은 피드백으로 되돌려 1회 재추출, 그래도 실패면 항목 보류
  → ⑤ 게이트: 핵심 필드(마감·자격) 검증 실패 시 브리프 전체 미발행 (fail-closed)
  → ⑥ 조언: 검증 통과 요건만으로 "처지별 분기 조언" 생성 (예비창업자라면 / 기창업자라면)
  → 판단 브리프 (JSON + Markdown)
```

설계 원칙은 세 가지입니다.

1. **오케스트레이션은 코드가 쥡니다.** LLM은 각 스텝의 추론만 담당합니다. 베타 모델의 능력 편차에
   흔들리지 않고, tool calling이 없어도 동작합니다.
2. **인용은 실존해야 발행됩니다.** `src/verify/`가 모든 evidence quote를 NFKC 정규화 후 원문에서
   substring 대조하고, 마감일과 지원금은 인용문에서 값을 재파싱해 한 번 더 대조합니다. 지어낸
   인용은 기계적으로 걸러집니다.
3. **개인정보는 LLM에 보내지 않습니다.** 개인화(내 조건 대조)는 `src/match/`의 결정적 규칙이
   로컬에서 수행하고, Solar에는 공개 공고 원문만 전달됩니다. 대신 공고 쪽에서 "처지별 분기 조언"을
   미리 생성해두고 클라이언트가 자기 분기만 렌더합니다. 개인화 체감과 개인정보 비전송을 동시에
   얻는 방법입니다. 공고문에 흔히 있는 담당자 연락처(이름·전화·이메일)도 `src/collect/contact.ts`가
   Solar로 보내기 전에 마스킹하고, 표시용 값은 코드가 따로 뽑아 브리프에 담습니다.

## 저장소 구조

```
src/
├── agent/        오케스트레이터 + 프롬프트 (프리체크 → 판정 → 추출 → 조언)
├── verify/       결정적 검증기: 인용 대조 · 날짜/금액 재파싱 · 충돌 · 발행 게이트
├── collect/      SSRF 가드 fetch · HTML/PDF/HWP/HWPX/DOCX 텍스트 추출 · EUC-KR 디코드 · precheck(도메인 티어·위험신호)
├── llm/          러너 추상화: solar (베타) | claude-code | codex (구독 CLI 폴백)
├── match/        로컬 프로필 매칭 (LLM 비전송)
├── brief/        브리프 렌더러 (Markdown/터미널/MCP)
├── cli.ts        analyze · today
├── mcp.ts        MCP 서버 (experimental)
└── worker.ts     foundin.kr 큐 폴링 워커 (STAGE A 중간 보고 · Supabase Realtime 즉시 깨우기 + 20초 폴링 폴백)
eval/calibrate.ts 모델 캘리브레이션 (JSON 준수율·장문·지연·tool calling 프로브)
eval/batch.ts     배치 평가 하니스 (발행/반려/보류율·인용 통과율·소요시간 집계, 지표 전용·무발행)
fixtures/ test/   오프라인 픽스처와 테스트
```

## 다른 AI 에이전트에서 도구로 쓰기 (MCP, experimental)

foundin은 MCP(Model Context Protocol) 서버를 내장하고 있습니다. Hermes Agent·Claude Code·Cursor 등
MCP 클라이언트에 등록해두면, 대화 중에 공고 분석이 필요할 때 에이전트가 foundin의 검증 파이프라인을
도구로 호출합니다. **대화층은 사실을 만들지 못하고, 원문 대조 검증을 통과한 도구 출력만 전달받는
구조입니다.**

```jsonc
// 에이전트의 MCP 설정에 추가 (예: Claude Code 의 .mcp.json)
{ "mcpServers": { "foundin": { "command": "npm", "args": ["run", "mcp"], "cwd": "<클론 경로>" } } }
```

도구는 세 개입니다: `analyze_announcement(url)` 정독·검증 브리프 (신규 URL은 4~6분 소요),
`check_eligibility(url, profile)` 조건 대조 (프로필은 로컬 규칙 매칭 전용, **LLM 미전송**),
`today(urls, profile)` 우선순위 브리핑.

미리 알아두시면 좋은 것들:

- LLM 비용은 사용자 본인의 키로 나갑니다. 베타 키가 없다면 `.env`에 `UPSTAGE_MODEL=solar-pro3` 등
  일반 콘솔 키로 쓸 수 있는 모델을 지정하세요
- 도구는 담당자 연락처를 출력에 포함하지 않고(연락처 LLM 비전송 원칙), 원문 인용은 "지시 아님"
  데이터 블록에 격리됩니다. 다만 **채팅창에 직접 입력하신 내용은 본인 에이전트의 대화로 전송됩니다.**
  그 경계는 사용자의 몫입니다
- 신뢰하지 않는 URL을 분석시킬 때는 에이전트의 파일·셸 권한을 제한하시길 권합니다
  (외부 문서를 읽는 모든 도구의 공통 주의사항입니다)
- experimental 단계라 인터페이스가 바뀔 수 있고, 이슈 대응은 베스트 에포트입니다

## 프로덕션에서는

foundin.kr에서 이 에이전트는 두 경로로 실행됩니다.

- 신규 수집 공고: 워커가 큐를 폴링해 자동으로 브리프를 생성합니다
- 사용자가 가져온 외부 공고 URL: 검증 게이트를 통과하면 공개 분석 페이지로 발행됩니다

Solar Open 2 베타 종료(2026-08-01) 후에는 러너를 `claude-code` / `codex` (구독 CLI, OAuth)로
전환해 같은 파이프라인이 계속 돕니다 (`FOUNDIN_RUNNER` 환경변수 하나로 바뀝니다).

## Solar Open 2 (Stage 1)

| 항목 | 값 |
| --- | --- |
| 모델 | `solar-open2` (Upstage Private Beta, 2026-07-17 ~ 07-31) |
| Rate Limit | 400 RPM / 150,000 TPM |
| Console | https://console.upstage.ai |

API 키는 `.env`로만 관리합니다. 커밋하지 마세요.

## 로드맵

- 마감 일정 관리 · 지원사업 간 자격 충돌 확인 · 사업계획서 작성 체크리스트 자동화
- 브리프 정확도 평가 코퍼스 공개 (골든셋 대비 필드 정확도·인용 통과율)

## 참고

- Upstage Solar Agent Partner Program Stage 1 (2026-07-17 ~ 07-31) 참여작입니다
- 모든 브리프는 **참고용**입니다. 최종 확인은 반드시 공고 원문에서 해주세요. 브리프에는 항상 원문
  링크가 포함됩니다
