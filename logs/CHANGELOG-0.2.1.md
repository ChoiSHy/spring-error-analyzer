# Spring Boot Error Analyzer - 변경 내용 요약

> 버전: `0.2.0` | 빌드: `spring-boot-error-analyzer-0.2.0.vsix` (256.93 KB)

---

## 프로젝트 개요

VSCode 확장 프로그램으로, Spring Boot 애플리케이션을 실행하고 에러를 **로컬 패턴 매칭 + Claude AI**로 분석하는 도구.

---

## 구현된 기능 목록

### 🔴 고우선순위 기능 (Features 1~3)

#### 1. 로그 필터링 / 검색

- **레벨 필터 버튼**: `ERROR` / `WARN` / `INFO` / `DEBUG` 토글
- **키워드 검색**: 실시간 검색 + `<mark>` 태그로 하이라이트
- **매치 카운트**: `"12 / 48"` 형태로 필터된 줄 수 표시
- **자동 스크롤**: 하단 60px 이내일 때만 스크롤 (수동 스크롤 보존)

#### 2. 에러 중복 그룹화 (Deduplication)

- **그룹 키**: `logger + message[:120]` 복합 키로 동일 에러 묶음
- **발생 횟수 배지**: `×3` 형태로 반복 횟수 표시
- **최신 타임스탬프** 업데이트, 대표 에러(첫 발생)로 분석 실행
- **탭 배지**: 서비스 탭에 전체 에러 발생 횟수 표시

#### 3. 에러 알림

- **VSCode 상태바**: `🔥 Spring ⚡ 실행중 서비스수 ❌ 에러수` 동적 업데이트
- **팝업 알림**: 첫 에러 발생 시 + 이후 5회마다 `showWarningMessage` 팝업

---

### 🟡 중간우선순위 기능 (Features 7~8)

#### 7. Port Kill 버튼

- **자동 감지**: `PortInUseException` / `Address already in use` 에러 시 포트 번호 파싱
- **UI 버튼**: 분석 패널에 `"포트 8080 프로세스 종료"` 버튼 표시
- **플랫폼 대응**:
  - Windows: `netstat -ano | findstr :PORT` → `taskkill /PID /F`
  - Unix/Mac: `lsof -ti tcp:PORT` → `kill -9`
- **결과 표시**: 성공/실패 메시지 인라인 표시

#### 8. LocalAnalyzer 패턴 확장

기존 20개 → **26개 패턴**으로 확장

| 추가된 패턴 | 신뢰도 |
|---|---|
| `UnsatisfiedDependencyException` | 0.90 |
| `CircularDependencyException` | 0.95 |
| `PropertyNotFoundException` | 0.88 |
| `ConnectException` (DB 연결 실패) | 0.87 |
| `EntityNotFoundException` | 0.90 |
| `OptimisticLockingException` | 0.92 |

---

### 🟢 신규 기능: Webview에서 서비스 추가

**기존**: `Ctrl+P → "Spring Boot: Start Service"` 커맨드 팔레트만 가능
**개선**: Webview 패널 UI에서 직접 클릭으로 추가

#### 동작 흐름

```
① "＋ 서비스 추가" 버튼 클릭 (헤더 or 빈 화면)
② 모달 열림 → extension이 워크스페이스 스캔
③ build.gradle / pom.xml 기준 Spring Boot 모듈 자동 탐지
④ 체크박스 목록으로 표시 (이미 추가된 모듈은 비활성화)
⑤ 선택 후 "추가 및 시작" → 서비스 등록 + 자동 실행
```

#### 모달 UI 구성

- **로딩 스피너** → 탐지 완료 후 모듈 목록 렌더링
- **배지**: Gradle/Maven 구분, 멀티모듈 표시, 이미 추가됨 표시
- **선택 카운트**: `"2개 선택됨"` 실시간 업데이트
- **오버레이 클릭** 시 모달 닫기

---

## 변경 파일 목록

| 파일 | 변경 내용 |
|---|---|
| `src/types/index.ts` | `KillPortMessage`, `RequestDetectModulesMessage`, `AddAndStartModulesMessage`, `DetectedModuleInfo`, `DetectModulesResult`, `PortKillResult` 타입 추가 |
| `src/extension.ts` | 상태바 동적 업데이트, 에러 알림 팝업 추가 |
| `src/analyzer/LocalAnalyzer.ts` | 에러 패턴 20 → 26개 확장 |
| `src/webview/WebviewProvider.ts` | 모달 HTML, `detectAndSendModules()`, `addAndStartModules()`, `killPort()` 추가 |
| `src/webview/script.js` | 로그 필터, 에러 그룹화, Port Kill, 서비스 추가 모달 로직 |
| `src/webview/style.css` | 로그 필터 UI, 에러 배지, Port Kill 버튼, 모달 전체 스타일 |

---

## 빌드 방법

```bash
# 컴파일
npm run compile

# .vsix 패키지 생성
npx vsce package --allow-missing-repository --allow-star-activation
```

## 설치 방법

VSCode → `Extensions: Install from VSIX...` → `spring-boot-error-analyzer-0.2.0.vsix` 선택
