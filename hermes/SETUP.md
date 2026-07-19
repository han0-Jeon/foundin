# hermes 심사역 데스크 가동 (5분)

전제: foundin.kr 에 feat/solar-brief 머지·배포 + Supabase 057 적용 + Vercel 에 `BRIEF_WORKER_SECRET` 등록.

```bash
# 1. 코드
ssh hermes
git clone https://github.com/han0-Jeon/foundin.git ~/foundin   # 이미 있으면 git pull
cd ~/foundin && npm install

# 2. 환경
cp .env.example .env
# .env 에 채우기:
#   UPSTAGE_API_KEY=      (console.upstage.ai 발급)
#   FOUNDIN_BASE_URL=https://foundin.kr
#   BRIEF_WORKER_SECRET=  (Vercel 과 동일 값)
#   WORKER_CONCURRENCY=3  (베타 기간. 8/1 이후 구독 러너 전환 시 1)

# 3. 가동
pm2 start npm --name brief-worker -- run worker
pm2 save
pm2 logs brief-worker --lines 20
```

캘리브레이션 (키 받은 직후 1회):

```bash
cd ~/foundin && npm run calibrate   # eval/calibration-report.md 생성
```

편집국 세계관 연결 (선택): `hermes/soul-심사역.md` 를 `~/foundin-newsroom/hermes/souls/` 로 복사.

8/1 베타 종료 후: `.env` 의 `FOUNDIN_RUNNER=claude-code` (또는 codex) 로 바꾸고 재시작.
백필(기존 활성 공고 일괄 큐 적재)은 vibebuilder 쪽 스크립트로 수행 — 후속 작업 참고.
