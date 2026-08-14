# HANDOFF.md — 프로젝트 인수인계 문서

작업을 중단했다가 다시 시작할 때, 또는 기기를 옮길 때 **이 파일 하나만 읽으면 현재 상태를 파악**할 수 있도록 정리한 문서입니다.

- 마지막 갱신: 2026-08-14
- 기준 커밋: `6829bfd` (Implement Kakao send-to-me delivery, 2026-08-10 16:18 KST)
- 저장소: `youngsamshin13-alt/idea`

---

## 1. 이 프로젝트는 무엇인가

**아침 카카오 우선순위 알림 MVP** (`morning-kakao-priority`)

할 일을 중요도별로 정리해두면, 다음 날 아침 카카오톡으로 우선순위 브리핑을 보내주는 웹 앱입니다. 카카오 계정으로 로그인해 사용자별로 할 일이 분리됩니다.

빌드 도구나 프레임워크 없이 **순수 HTML / CSS / JavaScript + Node.js**로만 만들어져 있습니다.

---

## 2. 현재 어디까지 되어 있나

### 완료된 기능

| 기능 | 상태 |
|---|---|
| 카카오 REST OAuth 로그인 / 로그아웃 | 완료 |
| 서버 세션 기반 인증 (토큰을 브라우저에 저장하지 않음) | 완료 |
| 사용자별 할 일 분리 | 완료 |
| 할 일 추가 / 중요도 지정 (높음·보통·낮음) | 완료 |
| 중요도 우선 정렬 | 완료 |
| 완료 처리 / 하루 미루기(snooze) | 완료 |
| 할 일을 서버(D1)에 저장 | 완료 |
| 카카오 "나에게 보내기" 메시지 발송 | 완료 |
| 브리핑 발송 이력 기록 (중복 발송 방지) | 완료 |
| 내부 예약 발송 진입점 `/internal/deliver-due-briefings` | 완료 |
| Cloudflare Sites(Worker + D1) 배포 빌드 | 완료 |
| React Bits 스타일 텍스트 효과 (그라디언트, TextType) | 완료 |

### 아직 안 된 것 — 여기서부터 이어가면 됩니다

1. **자동 스케줄러가 없습니다.** `/internal/deliver-due-briefings` 진입점은 만들어져 있지만, 이걸 매일 아침 자동으로 호출해주는 장치(Cloudflare Cron Trigger 등)가 아직 없습니다. 지금은 수동으로 POST를 보내야 발송됩니다. **가장 유력한 다음 작업입니다.**
2. **로컬 서버는 메모리 세션입니다.** `server.js`를 재시작하면 로그인이 풀립니다. (Worker 버전은 D1에 저장하므로 해당 없음)
3. **발송 시각이 고정입니다.** 사용자가 원하는 시각을 고를 수 없습니다.
4. **`memory.md`의 옛 기록이 한글 깨짐 상태입니다.** 2026-08-10 15:17 커밋(`edff810`)에서 인코딩을 고쳤지만, 그 이전에 기록된 항목들은 깨진 채로 남아 있습니다.

---

## 3. 구조 — 중요한 특징

이 프로젝트는 **같은 앱을 두 벌로 구현**해 두었습니다. 한쪽만 고치면 다른 쪽과 어긋나므로 주의하세요.

```
로컬 개발용                     배포용 (Cloudflare)
─────────────                   ──────────────────
server.js                       sites-worker-template.mjs
Node.js http 서버               Cloudflare Worker
메모리 세션 / 파일 저장          D1 데이터베이스
localhost:3000                  Cloudflare Sites
```

`build-sites.js`가 `index.html` / `app.js` / `styles.css` 등을 문자열로 직렬화해서 `sites-worker-template.mjs`의 `__ASSET_MAP__` 자리에 끼워 넣고 `dist/server/index.js`를 만들어냅니다.

> **주의:** 서버 로직을 바꿀 때는 `server.js`와 `sites-worker-template.mjs` **양쪽 모두** 수정해야 합니다. 두 파일은 라우트 구성과 함수 이름이 거의 1:1로 대응합니다.

### 파일별 역할

| 파일 | 역할 |
|---|---|
| `login.html` / `login.js` | 로그인 전 화면, 실패·취소 안내 |
| `index.html` / `app.js` | 로그인 후 할 일 화면, 정렬·완료·미루기·화면 효과 |
| `styles.css` | 두 화면 공통 스타일 |
| `server.js` | 로컬 개발 서버 (OAuth 콜백, API, 세션, 보호된 파일 제공) |
| `sites-worker-template.mjs` | Cloudflare Worker 버전 (D1 연동) |
| `build-sites.js` | 배포 번들 생성 |
| `setup-kakao.ps1` | 카카오 키를 `.env`에 넣어주는 Windows 설정 도우미 |
| `PRD.md` / `design.md` | 기획서 / 디자인 문서 |
| `AGENTS.md` | AI 개발자 역할 및 작업 규칙 |
| `memory.md` | **작업 기록 로그** (아래 5절 참고) |

### API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/auth/kakao` | 카카오 로그인 시작 |
| GET | `/auth/kakao/callback` | OAuth 콜백 |
| POST | `/auth/logout` | 로그아웃 |
| GET | `/session.js` | 현재 세션 정보를 JS로 전달 |
| GET | `/api/tasks` | 할 일 목록 |
| POST | `/api/tasks` | 할 일 추가 |
| POST | `/api/tasks/:id/complete` | 완료 처리 |
| POST | `/api/tasks/:id/snooze` | 하루 미루기 |
| POST | `/internal/deliver-due-briefings` | 예약 발송 트리거 (비밀값 필요) |

### D1 스키마

```
users     user_id(PK), display_name, nickname, access_token,
          access_token_expires_at, refresh_token,
          refresh_token_expires_at, updated_at

sessions  session_id(PK), user_id(FK), created_at, expires_at

tasks     id(PK), user_id(FK), text, priority, created_at,
          snoozed_until, completed_at, updated_at

briefings id(PK), user_id(FK), delivery_date, scheduled_for, sent_at,
          status, result_code, message, error_message, task_count
          UNIQUE(user_id, delivery_date)   ← 하루 1회 발송 보장
```

스키마는 `sites-worker-template.mjs`가 첫 요청 때 `CREATE TABLE IF NOT EXISTS`로 자동 생성합니다. 별도 마이그레이션 도구는 없습니다.

---

## 4. 실행 방법

### 환경 변수

`.env` 파일은 Git에 올라가지 않습니다(`.gitignore`). 새 기기에서는 **반드시 다시 만들어야 합니다.** `.env.example`을 복사해서 채우세요.

```
KAKAO_REST_API_KEY=       카카오 REST API 키
KAKAO_CLIENT_SECRET=      카카오 Client secret
SESSION_SECRET=           32자 이상의 긴 비밀값
DELIVERY_WEBHOOK_SECRET=  내부 발송 트리거용 비밀값
APP_ORIGIN=http://localhost:3000
PORT=3000
```

Windows에서는 도우미 스크립트를 쓰면 편합니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-kakao.ps1
```

카카오 개발자 콘솔에 Redirect URI로 `http://localhost:3000/auth/kakao/callback`을 등록해야 합니다.

### 명령어

```powershell
npm start        # 로컬 서버 실행 → http://localhost:3000
npm run build    # dist/server/index.js 생성 (Cloudflare 배포용)
npm run check    # 전체 JS 구문 검사
```

`index.html`을 `file://`로 직접 열면 로그인이 동작하지 않습니다. 반드시 서버를 통해 접속하세요.

Node.js 18 이상이 필요합니다.

---

## 5. 작업 기록 규칙 (`memory.md`)

이 프로젝트에는 **핵심 작업이 끝날 때마다 `memory.md`에 바로 한 줄 추가**하는 규칙이 있습니다. 형식은 다음과 같습니다.

```
- YYYY-MM-DD HH:MM:SS KST | 무엇을 했는지 | `바꾼파일1`, `바꾼파일2`
```

기록 대상은 새 기능 추가, 핵심 수정, 기능 제거입니다.

**이 규칙을 지키면 "지난번에 뭐 하다 말았지?"라는 상황이 생기지 않습니다.** 작업을 멈추기 전에 `memory.md`를 갱신하고 커밋하는 습관을 들이세요.

---

## 6. 작업을 재개하는 방법

### 새 기기 / 클라우드에서 처음 시작할 때

```bash
git clone https://github.com/youngsamshin13-alt/idea.git
cd idea
cp .env.example .env      # 그리고 값 채우기
npm start
```

### 이미 받아둔 폴더에서 이어갈 때

```bash
git pull origin main
```

### 지금 상태를 확인하는 순서

1. `HANDOFF.md` (이 파일) — 전체 구조 파악
2. `memory.md` 최신 항목 — 마지막에 뭘 했는지
3. `git log --oneline -10` — 커밋 흐름
4. `git status` — 커밋 안 된 변경사항이 있는지

---

## 7. 다음에 할 일 후보

우선순위 순으로 정리했습니다.

1. **자동 발송 스케줄러 연결** — Cloudflare Cron Triggers로 매일 아침 `/internal/deliver-due-briefings`를 호출하도록 설정. 현재 가장 큰 빈 구멍입니다.
2. **발송 시각 사용자 설정** — 지금은 고정. `users` 테이블에 컬럼 추가 필요.
3. **로컬 서버 세션 영속화** — `server.js`도 파일이나 SQLite에 세션 저장 (선택 사항)
4. **`memory.md` 깨진 한글 복원**
5. **발송 실패 재시도** — `briefings.status`와 `error_message`는 이미 기록 중이므로, 실패 건 재시도 로직만 붙이면 됩니다.
