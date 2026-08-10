# 아침 카카오 우선순위 알림 MVP

카카오 실제 로그인 후 사용자별로 할 일을 정리하는 순수 HTML, CSS, JavaScript 프로젝트입니다. 로그인 토큰은 브라우저에 저장하지 않고 Node.js 서버 세션에서만 보관합니다.

## 포함한 범위

- 카카오 REST API OAuth 로그인과 로그아웃
- 사용자별 브라우저 저장 공간 분리
- 기존 공용 할 일을 첫 로그인 계정에 한 번 복사
- 할 일 입력과 `높음 / 보통 / 낮음` 중요도 선택
- 중요도 우선 정렬, 완료, 하루 미루기
- 다음 날 아침 카카오톡 브리핑 미리보기

## 처음 한 번 설정

1. [Kakao Developers](https://developers.kakao.com/)에서 애플리케이션을 만듭니다.
2. `카카오 로그인`을 활성화합니다.
3. REST API 키 설정에서 Redirect URI로 아래 주소를 등록합니다.

```text
http://localhost:3000/auth/kakao/callback
```

4. REST API 키의 Client secret을 확인하고 활성화합니다.
5. 프로젝트 폴더에서 설정 도우미를 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-kakao.ps1
```

입력한 키는 Git에서 제외되는 `.env` 파일에만 저장됩니다. 키를 HTML이나 JavaScript 파일에 직접 적지 마세요.

## 실행 방법

```powershell
npm.cmd start
```

브라우저에서 `http://localhost:3000`을 엽니다. 카카오 실제 로그인은 서버가 필요하므로 `index.html`을 `file://`로 직접 열어서는 동작하지 않습니다.

구문 검사는 다음 명령으로 실행합니다.

```powershell
npm.cmd run check
```

## 파일 구성

- `login.html`: 카카오 로그인 전 화면
- `index.html`: 로그인 후 할 일 화면
- `styles.css`: 로그인과 할 일 화면 스타일
- `login.js`: 로그인 실패·취소 안내
- `app.js`: 사용자별 저장, 정렬, 완료, 미루기와 화면 효과
- `server.js`: OAuth 콜백, 카카오 API, 서버 세션, 보호된 파일 제공
- `setup-kakao.ps1`: REST API 키와 Client secret 로컬 설정 도우미
- `.env.example`: 필요한 환경 변수 예시

## 현재 제한

- 서버를 다시 시작하면 메모리 세션이 사라져 다시 로그인해야 합니다.
- 할 일은 계정별 키로 분리되지만 현재 브라우저의 `localStorage`에 저장되므로 다른 기기와 동기화되지 않습니다.
- 실제 카카오톡 메시지 발송 방식은 아직 결정되지 않았습니다.
