# 선택 기능: 초기 웹 관리 화면

현재 기본 제품은 MCP 서버입니다. Codex·Claude 사용에는 이 화면이 필요하지 않습니다.

초기 웹 화면을 별도로 확인하려면 프로젝트 폴더에서:

```sh
npm ci
npm run ui
```

http://localhost:4310 에 접속합니다. 종료하려면 터미널에서 Ctrl+C를 누릅니다.

- 웹 화면은 이전 JSON 파일(`data/runs`, `data/schedules.json`)을 사용합니다.
- MCP는 SQLite(`data/mcp`)를 사용하므로 두 방식의 실행 기록은 서로 다릅니다.
- `start.cmd`는 이제 MCP 연결 설정을 생성합니다. 웹 서버를 실행하지 않습니다.
- 포함된 Dockerfile과 compose.yaml은 이 선택 웹 화면용 초기 구성입니다. Docker 실행은 검증하지 않았습니다. MCP 연결에는 Docker가 필요하지 않습니다.
