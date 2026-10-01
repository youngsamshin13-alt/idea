---
name: sns-music-playlist
description: 유튜브 음악 플레이리스트 제작. "플레이리스트 만들어", "음악 영상 제작", "플리" 요청 때 사용. 콘셉트 → 음악 프롬프트 → Abocado/Suno/Mureka 음악 생성 → 영상 메타데이터 → 쇼츠·릴스 파생까지 진행한다.
---

# 음악 플레이리스트 파이프라인

인자: 콘텐츠 id (`sns-automation/data/contents.json`). 없으면 `node sns.js new music "<제목>"`으로 먼저 등록한다.

## 단계
1. **콘셉트**: `output/<id>/brief.md`를 읽고 분위기·상황·곡 수·길이를 사용자와 확정한다. (예: "비 오는 날 카페 재즈, 10곡, 약 40분")
2. **프롬프트**: 곡마다 장르·템포·악기·분위기가 조금씩 다른 프롬프트를 만든다. Gemini에서 만든 프롬프트가 있으면 그대로 받아 쓴다. `output/<id>/prompts.md`에 저장한다.
3. **음악 생성**
   - Abocado: `abocado_music_playlist` / `abocado_music_compose`. 생성 전 반드시 `abocado_check_cost`로 차감액·잔액을 보여주고 승인을 받는다.
   - Suno·Mureka: MCP가 없으므로 프롬프트를 복사해서 쓸 수 있는 형태로 정리해 준다.
4. **메타데이터**: 제목(검색어 포함), 설명(타임스탬프 + AI 제작 표기), 태그 15개, 썸네일 문구 2안을 `brief.md`에 채운다.
5. **파생 작업**: 하이라이트 30초 구간 3개를 골라 쇼츠·릴스용으로 표시하고 `/sns-social-repost`로 넘긴다.
6. 업로드가 끝나면 `node sns.js done <id> youtube-music`.

## 규칙
- 플레이리스트마다 썸네일·설명·곡 구성을 다르게 한다 (유튜브 반복 콘텐츠 정책).
- 상업 이용은 Suno·Mureka 유료 플랜 기간에 만든 곡만 사용한다.
- 업로드·게시는 사용자 확인 후에만 한다.
