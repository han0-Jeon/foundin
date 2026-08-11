# 스키마 v3 후보 검증 리포트 (facts-first §8-2)

실행: 2026-08-11T05:18:38.608Z · 표본 60건 (분석 성공 58 · 실패 2)

> 측정 전용입니다. DB 기록·발행을 하지 않습니다.

## 필드별 채움률과 근거

| 필드 | 값 있음 | 비율 | 근거 대조 통과 | 근거율 |
| --- | ---: | ---: | ---: | ---: |
| target_industries | 48 | 82.8% | 29 | 60.4% |
| company_scale | 28 | 48.3% | 25 | 89.3% |
| org_type | 5 | 8.6% | 5 | 100.0% |

"값 있음" = "무관"·빈 배열이 아닌 것. 근거율이 낮으면 모델이 상식으로 메웠다는 뜻이라 필드로 쓸 수 없습니다.

## 값 분포 (판별력)

- company_scale: 중소기업 18 · 소상공인 10 · 무관 30
- org_type: 무관 53 · 법인 4 · 개인 1

한 값이 압도적이면 필드를 만들어도 매칭에서 공고를 가르지 못합니다.

## 업종 상위 15

- 16건 · 무관
- 4건 · 혁신성장분야
- 4건 · 초격차·신산업 분야
- 4건 · 지역주력산업
- 4건 · 뿌리산업
- 4건 · 뿌리기술
- 4건 · 소재·부품·장비산업
- 3건 · 제조업
- 2건 · 딥테크
- 2건 · 제조분야
- 2건 · 디지털미디어관련분야
- 2건 · 지식서비스분야
- 2건 · 제조
- 2건 · 사회적경제
- 1건 · 화학제조업

어휘가 얼마나 흩어지는지가 관건입니다 — 같은 업종이 여러 표기로 갈리면 선택지(대분류)로 못 만듭니다.
서로 다른 업종 라벨 72종.

## 분석 실패 2건

- extract: [
  {
    "code": "too_small",
    "minimum": 4,
    "type": "string",
    "inclusive": true,
    "exact": false,
    "m — https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=178680
- extract: [
  {
    "code": "too_big",
    "maximum": 12,
    "type": "array",
    "inclusive": true,
    "exact": false,
    "mes — https://www.mss.go.kr/site/smba/ex/bbs/View.do?cbIdx=310&bcIdx=1064197
