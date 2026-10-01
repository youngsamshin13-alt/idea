# SNS 수익화 자동화 시스템

전체 요구사항과 흐름은 [PRD.md](PRD.md), 팀 구성과 자동화 전략은 [AGENTS.md](AGENTS.md)에 있습니다.

본편 콘텐츠 하나를 만들면 쇼츠·인스타·페이스북·스레드·블로그용 파생 작업이 자동으로 생기고, Claude Code 스킬이 각 작업을 처리하는 구조입니다.

```
[주제 기획] 월요일 루틴 /sns-topic-plan ──▶ node sns.js topic pick ──▶ [본편 제작 스킬] ──▶ [재가공 스킬] ──▶ [수익 기록]
                     │                  /sns-music-playlist    /sns-social-repost   node sns.js income
                     │                  /sns-workout-video     /sns-blog-post       node sns.js cost
                     │                  /sns-shopping-shorts
                     └─ output/<id>/brief.md + 채널별 작업 목록
```

## 콘텐츠 라인 (config/pipelines.json)

| 라인 | 목적 | 주간 목표 | 본편 → 파생 |
|---|---|---|---|
| music 음악 플레이리스트 | 장기 자산 (애드센스) | 2 | 유튜브 → 쇼츠, 릴스, 페북, 스레드 |
| workout 운동 영상 | 신뢰 쌓기 | 2 | 유튜브 → 쇼츠, 카드뉴스, 페북, 스레드, 블로그 |
| shopping 쇼핑 쇼츠 | 빠른 현금 (제휴) | 3 | 쇼츠 → 릴스, 페북, 스레드, 블로그 |
| blog 블로그 단독 글 | 검색 유입 | 2 | 블로그 → 카드뉴스, 스레드 |

쇼핑 쇼츠는 운동 영상에 나온 용품을 우선 다룹니다. 운동 채널 시청자가 그대로 구매 고객이 되도록 하기 위해서입니다.

## 도구 역할 (config/subscriptions.json)

| 도구 | 역할 | 연동 |
|---|---|---|
| Claude Pro (Claude Code) | 전체 지휘, 스킬 실행, 업로드 자동화 | 이 저장소 |
| Abocado AI | 플레이리스트·음악·이미지 생성 | MCP 연결됨 |
| Higgsfield Plus | 운동 영상·이미지 생성 | MCP 연결됨 |
| ChatGPT Pro (Codex) | 새 운동 영상 제작, 지원사업 | 스킬이 Codex용 지시서 작성 |
| Gemini 플러스 | 음악 프롬프트, 자료 정리 | 수동 (결과를 붙여넣기) |
| Google AI Pro (Flow) | 쇼핑 쇼츠 영상 | 스킬이 Flow용 프롬프트 작성 |
| Suno Premier / Mureka Pro | 음악 제작 | 스킬이 프롬프트 정리 |

## 사용법

```bash
cd sns-automation
node sns.js topic                         # 주제 후보 보기 (점수순)
node sns.js topic pick <id>               # 후보 승인 → 본편 등록
node sns.js topic drop <id>               # 후보 버리기
node sns.js plan                          # 이번 주 목표·루틴 (plans/에 저장)
node sns.js new workout "10분 하체 루틴"   # 본편 등록 + 파생 작업 자동 생성
node sns.js status                        # 채널별 남은 작업과 실행할 스킬
node sns.js done <id> youtube-workout     # 작업 완료 (채널 생략 시 전체)
node sns.js income 쿠팡파트너스 32000      # 수익 기록 (원)
node sns.js cost                          # 구독료 합계·겹치는 구독·손익분기
node sns.js report                        # 주간 수익 보고 (plans/<주>-report.md)
```

Claude Code에서는 `/sns-weekly`로 시작하면 계획 → 남은 작업 → 손익을 정리해서 다음에 할 스킬을 알려 줍니다.

## 주간 루틴

| 요일 | 할 일 |
|---|---|
| 월 08:44 | 루틴이 주제 후보 생성 (`/sns-topic-plan`) |
| 월 | 후보 검토 → `topic pick`, Gemini로 음악 프롬프트 정리 |
| 화 | `/sns-music-playlist` |
| 수 | `/sns-workout-video` |
| 목 | `/sns-shopping-shorts` |
| 금 | `/sns-blog-post` |
| 매일 | `/sns-social-repost` (인스타 → 페북 → 스레드) |
| 일 | 수익 입력(`income`) → 19:52 루틴이 주간 수익 보고 생성 (`report`) |

## 안전 규칙 (모든 스킬 공통)
- 크레딧이 드는 생성은 차감액을 먼저 보여주고 승인을 받은 뒤 실행합니다.
- 업로드·게시는 사용자 확인 후에만 합니다.
- 제휴 콘텐츠에는 `disclosure.affiliate` 광고 문구를, 모든 콘텐츠에는 AI 활용 표기를 넣습니다.
- 상품 링크·가격·후기·효과는 지어내지 않습니다.

## 먼저 할 일
1. `config/subscriptions.json`에서 `verified: false`인 금액을 실제 결제 금액으로 고치세요.
2. 겹치는 구독을 정리하세요: Gemini 플러스 ↔ Google AI Pro, Suno ↔ Mureka, ChatGPT Pro → Plus 전환 검토.
3. 이 폴더는 할 일 앱(`server.js` 등)과 별개이며 Node.js 기본 모듈만 사용합니다.
