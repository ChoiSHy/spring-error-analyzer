# Spring Boot Error Analyzer

Spring Boot 애플리케이션을 VSCode 내에서 실행하고, 발생한 에러를 **로컬 패턴 분석** 및 **Claude AI**로 실시간 분석하는 VSCode 확장입니다.

---

## 주요 기능

### 서비스 관리
- 워크스페이스 내 Spring Boot 모듈 자동 탐지 (Gradle / Maven)
- 멀티 모듈 프로젝트 지원
- 여러 서비스를 탭으로 동시 실행·관리
- `redhat.java` 연동 시 JDT 방식으로 빠르게 실행 (JVM 1개, 메모리 ~700MB 절약)

### 실시간 로그
- stdout / stderr 스트리밍 출력
- ERROR / WARN / INFO / DEBUG 레벨 필터
- 키워드 검색 및 하이라이트
- 로그 패널 너비 드래그로 조절 (더블클릭으로 초기화)

### 에러 감지 및 분석
- 동일 에러 자동 그룹화 (중복 카운트 표시)
- **로컬 분석**: 26개 이상의 Spring Boot 에러 패턴 즉시 매칭
- **AI 분석**: 에러 + 소스 코드 컨텍스트를 Claude에 전달해 라인별 구체적 제안
- 포트 충돌 감지 및 점유 프로세스 원클릭 종료

### AI 분석 상세
- 스택 트레이스에서 사용자 코드 프레임 자동 추출 (프레임워크 내부 제외)
- 에러 발생 파일의 전후 20줄을 소스 코드로 함께 전송
- 분석 결과의 코드 블록 자동 강조 표시 (backtick 없이도 Java 패턴 감지)
- 에러 발생 라인 빨간색 마커(`>>>`) 시각화

---

## 설치

1. `.vsix` 파일 다운로드
2. VSCode → **Extensions** → `...` 메뉴 → **Install from VSIX...**
3. 설치 후 하단 패널에서 **Spring Error Analyzer** 탭 확인

---

## 빠른 시작

### 1. Claude API 키 설정

```
VSCode 설정 (Ctrl+,) → "springErrorAnalyzer.claudeApiKey" → API 키 입력
```

> AI 분석 없이 로컬 패턴 분석만 사용할 경우 API 키 불필요

### 2. 서비스 추가

- 하단 패널 **＋ 서비스 추가** 버튼 클릭
- 워크스페이스에서 자동 탐지된 모듈 선택 후 **추가 및 시작**

### 3. 에러 분석

1. **Errors** 패널에서 에러 항목 클릭
2. 로컬 분석 결과 자동 표시
3. **AI 분석 요청** 버튼으로 Claude AI 분석 실행
4. **소스 코드** 섹션에서 에러 발생 위치 코드 확인

---

## UI 구성

```
┌─────────────────────────────────────────────────────────────┐
│  Spring Boot Error Analyzer          [＋ 서비스 추가]        │
│  [service-a ●] [service-b ○]                                │
├──────────────────────┬──┬──────────┬────────────────────────┤
│                      │  │          │                        │
│        Logs          │▌ │  Errors  │      Analysis          │
│  (너비 드래그 조절)    │  │ (210px)  │   (에러 클릭 시 표시)   │
│                      │  │          │                        │
└──────────────────────┴──┴──────────┴────────────────────────┘
```

- `▌` : 드래그로 Logs 패널 너비 조절, 더블클릭으로 초기화
- Errors 패널: 기본 210px 고정 너비
- Analysis 패널: 나머지 공간 자동 확장

---

## 설정 옵션

| 설정 키 | 기본값 | 설명 |
|---|---|---|
| `springErrorAnalyzer.claudeApiKey` | `""` | Claude API 키 |
| `springErrorAnalyzer.claudeModel` | `claude-sonnet-4-5-20250929` | 사용할 Claude 모델 |
| `springErrorAnalyzer.maxAiRequestsPerMinute` | `10` | 분당 AI 분석 요청 제한 |
| `springErrorAnalyzer.buildTool` | `auto` | 빌드 도구 (`auto` / `gradle` / `maven`) |
| `springErrorAnalyzer.bootRunProfiles` | `""` | 활성화할 Spring 프로파일 (콤마 구분) |
| `springErrorAnalyzer.jvmArgs` | `""` | 추가 JVM 인수 |
| `springErrorAnalyzer.useJdt` | `auto` | 실행 방식 (`auto` / `always` / `never`) |

### `useJdt` 옵션 상세

| 값 | 동작 |
|---|---|
| `auto` | `redhat.java` 활성화 시 JDT 방식, 없으면 bootRun 자동 폴백 |
| `always` | 항상 JDT 방식 (`redhat.java` 필수) |
| `never` | 항상 `bootRun` / `spring-boot:run` 방식 |

---

## 에러 분석 흐름

```
로그 수신
   ↓
LogParser — ERROR / WARN 라인 감지
   ↓
LocalAnalyzer — 26개 패턴 즉시 매칭 (동기)
   ↓ 매칭 실패 또는 사용자가 AI 분석 요청
CodeContextExtractor — 스택 트레이스 → 소스 파일 탐색 → 코드 추출
   ↓
ClaudeAnalyzer — 에러 + 소스 코드 → Claude API 호출
   ↓
Analysis 패널에 결과 표시
```

### 로컬 분석 패턴 예시

- `NullPointerException`
- `BeanCreationException` / 순환 의존성
- `DataIntegrityViolationException` / `SQLException`
- `ConnectException` (DB/Redis 연결 실패)
- `PortInUseException`
- `MethodArgumentNotValidException`
- `AccessDeniedException`
- Spring Security 인증 오류
- 그 외 20개 이상

---

## 요구 사항

- VSCode `1.85.0` 이상
- JDK 설치 및 `java` 명령어 PATH 등록
- Gradle Wrapper(`gradlew`) 또는 Maven Wrapper(`mvnw`) 권장
- AI 분석: [Anthropic API 키](https://console.anthropic.com/)
- JDT 실행 모드: [Extension Pack for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-pack) (`redhat.java`)

---

## 프로젝트 구조

```
src/
├── extension.ts                 # VSCode 확장 진입점
├── analyzer/
│   ├── LogParser.ts             # 로그 라인 파싱 (정규식)
│   ├── LocalAnalyzer.ts         # 26개 에러 패턴 로컬 분석
│   ├── ClaudeAnalyzer.ts        # Claude API 호출 및 응답 파싱
│   └── CodeContextExtractor.ts  # 스택 트레이스 → 소스 코드 추출
├── services/
│   ├── ServiceManager.ts        # 멀티 서비스 오케스트레이션
│   └── SpringBootService.ts     # 프로세스 실행·로그 스트리밍·분석 요청
├── webview/
│   ├── WebviewProvider.ts       # VSCode Webview 생명주기
│   ├── script.js                # 프론트엔드 UI 로직
│   └── style.css                # 웹뷰 스타일
└── types/
    └── index.ts                 # TypeScript 타입 정의
```

---

## 빌드

```bash
npm install
npm run compile
npx vsce package --allow-missing-repository --allow-star-activation
```

---

## 버전 히스토리

| 버전 | 주요 변경 |
|---|---|
| `0.2.3` | 소스 코드 컨텍스트 AI 분석, 코드 블록 강조, 로그 패널 너비 조절 |
| `0.2.2` | JDT 실행 모드, 메모리 누수 수정, CSP 모달 버그 수정 |
| `0.2.1` | 로그 필터·검색, 에러 중복 그룹화, 포트 충돌 해결, 서비스 탐지 UI |
