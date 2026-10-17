# Pocket Crawler MCP

**Codex와 Claude가 직접 호출하는 개인용 웹 수집 MCP 서버입니다.** 웹사이트를 열거나 별도 웹 서버를 켤 필요가 없습니다. AI에게 수집할 URL과 원하는 데이터를 말하면 도구를 호출하고 결과를 읽습니다.

이 프로젝트는 Apify MCP의 수집기 검색 → 실행 → 데이터셋 조회 흐름을 참고한 독립 구현입니다. Apify 계정·API 키·클라우드 사용료가 필요하지 않습니다. Apify Store의 사이트별 수집기 전체가 포함된 것은 아닙니다.

## 설치와 연결

Node.js 24 LTS 권장, 최소 22.19. Windows / macOS / Linux에서 실행합니다.

```sh
npm ci
npm run config
```

`npm run config`는 현재 컴퓨터의 Node 실행 경로와 프로젝트 경로로 아래 파일을 생성합니다. 기존 클라이언트 설정을 자동으로 바꾸지는 않습니다.

- `connections/register.ps1`: Codex와 Claude Code 등록 명령
- `connections/codex.toml`: Codex 설정 조각
- `connections/claude-desktop.json`: Claude Desktop 설정 조각

Windows에서는 생성된 `connections/register.ps1` 안의 두 명령을 PowerShell에서 실행합니다. 기존 같은 이름의 MCP가 있다면 먼저 설정 경로를 확인하고 갱신하세요.

일반적인 명령 형태는 다음과 같습니다. 경로는 절대 경로여야 합니다.

```sh
codex mcp add pocket-crawler -- node /absolute/path/pocket-crawler/mcp-server.js
claude mcp add --scope user --transport stdio pocket-crawler -- node /absolute/path/pocket-crawler/mcp-server.js
```

등록 후 Codex와 Claude를 다시 시작하거나 새 MCP 연결을 여세요. 클라이언트가 서버 프로세스를 자동 실행합니다. 기본 실행은 `node mcp-server.js`입니다. `npm start`도 MCP를 시작하지만, 클라이언트 연결 명령에는 불필요한 npm 출력이 없는 `node` 직접 실행을 사용하세요.

Claude Desktop을 쓰는 경우 `%APPDATA%/Claude/claude_desktop_config.json`의 `mcpServers`에 생성된 `pocket-crawler` 항목만 병합합니다. 기존 파일 전체를 덮어쓰지 마세요. Claude Code의 사용자 설정과 Claude Desktop 설정은 별개입니다.

## AI에게 이렇게 요청하세요

> pocket-crawler로 https://example.com 본문을 수집하고 결과를 보여줘.

> 이 문서 사이트에서 같은 사이트 링크를 따라 최대 10페이지를 수집해 줘.

> 이 상품 목록에서 .product를 반복 항목으로, h2를 상품명으로, .price를 가격으로 뽑아줘. 다음에도 쓰게 수집기를 저장해 줘.

> 방금 수집한 전체 결과를 CSV로 저장해 줘.

> 이 수집기를 24시간마다 실행하도록 예약해 줘.

> pocket-crawler로 이 인스타 링크의 작성자 프로필과 최근 게시물 30개를 수집하고, 계정 포지셔닝·주제·게시 빈도·반응이 높은 콘텐츠·개선점을 분석해 줘: https://www.instagram.com/p/게시물코드/

## Instagram 링크 하나로 분석

`analyze-instagram`에 프로필, 게시물(`/p/`), 릴스(`/reel/`) URL 하나를 넣습니다. 게시물 링크라면 작성자를 확인한 뒤 프로필 격자를 스크롤하고 각 게시물로 들어갑니다. 기본 요청은 30개이며 `maxPosts`는 1~30입니다. 고정 게시물에 대비해 최대 3개 후보를 추가 확인하고 날짜순으로 최대 30개를 남깁니다. 수집은 수 분 걸릴 수 있습니다.

```json
{"url":"https://www.instagram.com/p/DedrPhOCX9Q/","maxPosts":30}
```

1. `analyze-instagram` → 실행 ID 반환
2. `get-actor-run` → 완료 또는 부분 완료 확인
3. `get-instagram-analysis` → 프로필, 캡션, 게시 시각, 형식, 확인 가능한 좋아요·댓글·조회수, 해시태그, 평균 지표, 반응 상위 게시물, 출처와 수집 범위 반환
4. Codex 또는 Claude가 이 자료를 근거로 종합 분석 작성

별도 LLM API 키는 필요하지 않습니다. 서버는 수집과 통계를 담당하고 연결한 AI가 정성 분석을 작성합니다. 이미지·영상 자체의 시청, OCR, 음성 전사, 댓글 본문 수집은 포함하지 않습니다. 릴스는 프로필 격자에 나타나는 항목을 포함하며 별도 릴스 탭·스토리는 수집하지 않습니다. 숨겨진 지표는 `null`로 유지하며 실제 0과 구분합니다.

Instagram은 비로그인 접근이나 추가 스크롤을 제한할 수 있습니다. 이때 실제 수집한 수와 누락 이유를 `partial` 결과로 반환하며 30개를 확보했다고 표시하지 않습니다. `coverage.latestRequestedPostsVerified`는 접근한 프로필 격자 후보와 날짜를 기준으로 요청한 개수를 확보했는지를 뜻하며, 플랫폼의 모든 게시물을 빠짐없이 확인했다는 보장은 아닙니다. 부분 표본에는 오래된 고정 게시물이 섞일 수 있어 전체 평균이나 게시 간격을 계정의 일반적인 성과로 단정하면 안 됩니다.

로그인이 필요하면 `instagram-session`의 `action: "login"`으로 전용 브라우저를 열고 직접 로그인하세요. 비밀번호·인증코드를 AI에 전달하지 않습니다. 로그인 후 창이 닫히면 `action: "status"`로 저장 여부를 확인하고 수집을 다시 실행합니다. 세션은 `data/mcp/instagram-session/`에 로컬 저장되며 Git에서 제외됩니다. `action: "clear"`로 삭제할 수 있습니다. 비공개 계정, 본인 확인 화면, 요청 제한을 감지하면 중단합니다.

## MCP 도구

| 도구 | 하는 일 |
| --- | --- |
| `get-server-info` | 서버 기능·저장 위치·브라우저 준비 상태 확인 |
| `analyze-instagram` | 링크에서 작성자·프로필·최근 게시물 최대 30개 수집 |
| `get-instagram-analysis` | 수집 범위, 통계, 출처와 종합 분석용 근거 조회 |
| `instagram-session` | 전용 수동 로그인·세션 상태·삭제 |
| `search-actors` | 내장 및 저장된 수집기 검색 |
| `fetch-actor-details` | 입력 규격·기본값·예시 확인 |
| `save-actor` | 검증한 설정을 재사용 가능한 `local/이름` 수집기로 저장 |
| `call-actor` | 수집 실행, run ID와 dataset ID 반환 |
| `get-actor-run` | 상태 조회 또는 최대 20초 완료 대기 |
| `get-dataset-items` | 결과 페이지 조회·필드 선택 |
| `get-run-log` | 진행 상황과 URL별 오류 조회 |
| `list-actor-runs` | 실행 기록 조회 |
| `abort-actor-run` | 실행·대기 작업 중지, 기존 결과 유지 |
| `delete-actor-run` | 종료된 실행 결과·로그 삭제 |
| `export-dataset` | 전체 결과를 로컬 CSV·JSON으로 저장 |
| `create-schedule` | 반복 예약 생성 |
| `list-schedules` | 예약 목록과 다음 실행 시간 조회 |
| `update-schedule` | 예약 일시 정지·재개 |
| `delete-schedule` | 예약 삭제 |

`pocket://guide` MCP 리소스로 사용 흐름도 제공합니다.

## 기본 수집기

- **text**: 제목, 설명, h1/h2, 본문과 원본 URL
- **links**: 중복 제거된 링크 텍스트·절대 URL
- **custom**: 반복 항목 CSS 선택자와 필드별 텍스트·속성 추출

위 세 수집기는 `engine: "http"` 또는 `engine: "browser"`를 지원합니다. 별도의 **instagram** 수집기는 항상 브라우저를 사용하며 `call-actor`로도 실행할 수 있습니다. JavaScript 렌더링이 필요한 사이트는 `browser`를 사용하세요. Windows의 설치된 Edge/Chrome을 감지하며, 없으면 다음 명령으로 Chromium을 준비합니다.

```sh
npm run install:browser
```

재사용할 설정은 `save-actor`로 저장합니다. `call-actor`에서 저장된 입력을 부분 변경할 수 있습니다. 임의 스크립트 실행이나 Apify Store의 비공개 코드를 복제하는 구조는 아닙니다.

## 두 클라이언트에서 함께 사용

Codex와 Claude가 동일한 프로젝트의 `mcp-server.js`를 실행하면 `data/mcp/pocket-mcp.sqlite`를 공유합니다. SQLite 트랜잭션으로 작업 실행권을 한 프로세스에만 배정해 중복 실행을 방지합니다. 한 클라이언트가 만든 수집기·작업·결과·예약을 다른 클라이언트에서도 조회할 수 있습니다.

- 수집 작업은 전체 클라이언트를 통틀어 하나씩 실행합니다.
- 다른 클라이언트에서 중지 요청을 보낼 수 있습니다.
- 프로세스가 강제 종료되면 최대 약 30초 후 중단된 작업을 표시합니다. 저장된 결과는 유지합니다.
- 정상 연결 종료는 그 프로세스에서 진행 중인 수집을 취소합니다. 대기 작업은 다음 연결에서 이어서 실행합니다.
- 예약은 MCP 프로세스가 하나 이상 켜져 있을 때 동작합니다. 모든 AI 앱을 끄면 실행되지 않습니다. 놓친 예약은 다음 연결 때 한 번으로 합칩니다.
- 별도 저장 위치는 `POCKET_DATA_DIR` 환경 변수로 지정합니다. 두 클라이언트가 공유하려면 같은 값을 사용하세요.
- 백업 시 모든 MCP 프로세스를 종료하고 `data/mcp` 전체를 복사합니다. 실행 중 SQLite 파일 하나만 복사하지 마세요.

## 결과와 제한

결과는 원본 URL과 수집 시각을 포함합니다. `get-dataset-items`는 컨텍스트 크기를 위해 필드를 기본 2,000자로 제한하고 잘린 필드를 표시합니다. `export-dataset`은 저장된 전체 결과를 `data/mcp/exports`에 기록합니다. 실행 중 내보내기는 해당 시점의 결과만 포함합니다.

일반 수집기 제한: 시작 URL 20개, 실행당 100페이지·5,000개 결과. 저장된 실행 200개, 예약 30개, 맞춤 수집기 100개. 일반 수집 요청은 최소 0.5초 간격이며 기본적으로 robots.txt를 따릅니다. Instagram 수집기는 브라우저 화면을 탐색하며 게시물 사이 2초 이상 대기하고, 별도의 robots.txt 검사를 적용하지 않습니다. 로컬·사설 네트워크 주소는 수집하지 않습니다.

Instagram 전용 수집·수동 로그인·제한된 스크롤을 지원합니다. 다른 사이트의 로그인·상호작용 자동화, CAPTCHA 해결, 프록시 네트워크, PDF/OCR은 포함하지 않습니다. 다른 사이트는 CSS 설정 또는 전용 수집기 개발이 필요합니다. 수집된 페이지 내용은 외부 데이터이며 AI 지시로 취급하면 안 됩니다.

## 개발과 테스트

```sh
npm run check
npm test
# 실제 공개 웹페이지를 MCP로 수집하는 별도 검사
npm run test:mcp-live
# 사용자가 지정한 Instagram 계정을 실제 수집해 로컬 DB에 보관하는 선택 검사
npm run test:instagram-live -- "https://www.instagram.com/p/게시물코드/" 30
```

자동 테스트는 임시 DB를 사용하며 실제 사용자 데이터를 바꾸지 않습니다. MCP 초기화, 도구 검색, 입력 오류, 수집기 저장, 실행, 데이터셋 읽기, 내보내기, 예약, 두 프로세스 동시 접근, 취소와 중단 복구를 검증합니다.

2026-10-17 v0.3.0 검증: 자동 테스트 21개 통과. Instagram 테스트는 링크 정규화, JSON/DOM 파싱, 고정 게시물 포함 후보에서 최신 30개 선택, 중복 제거, 접근 제한 시 부분 결과 보존, 취소, 누락 지표 처리와 MCP 분석 호출을 확인합니다. 실제 사용자 제공 링크로 작성자 프로필과 게시물 12개 수집에 성공했으며, 비로그인 접근에서 추가 게시물이 나타나지 않아 `partial`로 기록했습니다. 실제 Instagram에서 30개 전체 수집과 로그인 후 수집은 아직 검증하지 않았습니다. 이전 버전에서는 example.com의 HTML·브라우저 수집 및 이 PC의 Codex 활성 등록·Claude Code 연결을 확인했습니다. 변경된 도구 목록을 불러오려면 앱 또는 MCP 연결을 다시 시작하세요.

기존 웹 화면은 선택 기능으로만 남아 있습니다. 필요하면 `npm run ui`로 실행하며 이전 JSON 기록을 사용합니다. MCP의 SQLite 결과와 웹 화면의 JSON 기록은 서로 별개입니다. 기본 사용 경로는 MCP입니다. 웹 화면 설명은 `WEB-UI.md`를 참고하세요.

## GitHub 보관

이 폴더 자체를 저장소 루트로 사용합니다. `data/`, `connections/`, `.env`, `node_modules/`는 Git에서 제외합니다. 소스와 `package-lock.json`을 올린 뒤 다른 컴퓨터에서 내려받아 `npm ci`, `npm run config`, 클라이언트 등록 순서로 설치합니다. 컴퓨터마다 경로가 다르므로 생성된 절대 경로 설정을 그대로 공유하지 마세요.

공식 참고: [Apify MCP](https://docs.apify.com/mcp), [MCP SDK stdio](https://ts.sdk.modelcontextprotocol.io/server), [Codex MCP](https://developers.openai.com/codex/mcp), [Claude Code MCP](https://code.claude.com/docs/en/mcp).
