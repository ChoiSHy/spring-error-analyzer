# Spring Boot Error Analyzer - 변경 내용 요약

> 버전: `0.2.2` | 작업일: `2026-02-23`

---

## 개요

이번 버전은 신규 기능 추가보다 **안정성·성능·보안** 개선에 집중한 릴리스입니다.

- `redhat.java` (JDT Language Server) 연동으로 빠른 앱 실행 지원
- Webview CSP 위반으로 인한 모달 자동 오픈 버그 수정
- 서비스 재시작 시 메모리 누수 전면 해결

---

## 1. 신규 기능: JDT(Java Development Tools) 실행 모드

### 배경

기존 `gradle bootRun` / `mvn spring-boot:run` 방식은 Gradle 데몬·Maven JVM을 추가로 띄워
서비스 1개당 **JVM 2개 (~700MB~1GB 추가 메모리)** 가 소모됨.

### 구현 내용

`redhat.java` (Extension Pack for Java) 확장이 설치·활성화된 경우,
JDT Language Server가 제공하는 클래스패스 정보를 활용해
`java -cp <classpath> <MainClass>` 로 앱을 **직접 실행**함.

#### 실행 흐름

```
① _resolveJdtMode()  → redhat.java 활성 여부 확인
② _waitForJdtReady() → Language Server 완전 초기화 대기 (최대 30초)
   - 우선: javaExt.exports.onReady() 사용
   - 폴백: java.project.getClasspaths 폴링 (1.5초 간격)
③ vscode.java.resolveMainClass  → @SpringBootApplication 메인 클래스 탐색
④ java.project.getClasspaths    → 런타임 클래스패스 수집
⑤ spawn('java', ['-cp', classpath, mainClass])  → 앱 직접 실행
⑥ 실패 시 bootRun으로 자동 폴백
```

#### 설정 옵션 추가 (`package.json`)

| 설정 키 | 값 | 기본값 | 설명 |
|---|---|---|---|
| `springErrorAnalyzer.useJdt` | `auto` | ✅ | redhat.java 활성 시 자동 사용 |
| | `always` | | JDT 강제 사용 |
| | `never` | | bootRun 강제 사용 |

#### Windows 경로 버그 수정

Windows 경로(`c:\...`)를 JDT 커맨드에 raw 전달 시 URI 파싱 오류 발생.

```
오류: Illegal character in opaque part at index 2: c:\경로\...
해결: vscode.Uri.file(this.modulePath).toString() → file:///c%3A/...
```

#### JDT vs bootRun 비교

| | bootRun | JDT |
|---|---|---|
| JVM 인스턴스 수 | 2개 (빌드 도구 + 앱) | **1개** (앱만) |
| 빌드 도구 오버헤드 | ~700MB~1GB | **없음** |
| 로그 품질 | 빌드 로그 혼재 | **앱 로그만 수집** |

---

## 2. 버그 수정: Webview CSP 인라인 스타일 차단 → 모달 자동 오픈

### 원인

VSCode 웹뷰 CSP 정책:
```
style-src ${webview.cspSource} 'nonce-${nonce}';
```
`'unsafe-inline'` 없이는 **HTML 요소의 `style="..."` 인라인 속성이 모두 차단**됨.

이로 인해 `<div style="display:none;">` 이 무시되고,
CSS의 `.modal-overlay { display: flex }` 가 그대로 적용되어
**패널을 열 때마다 모달이 자동으로 표시**되는 버그 발생.

### 해결

**`style.css`** — CSP-safe `.hidden` 클래스 추가:
```css
.hidden { display: none !important; }
```

**`WebviewProvider.ts` (HTML 템플릿)** — 모든 인라인 `style=` 속성 제거:
```html
<!-- 이전 -->
<div id="add-service-modal" class="modal-overlay" style="display:none;">
<!-- 이후 -->
<div id="add-service-modal" class="modal-overlay hidden">
```

**`script.js`** — `.style.display` → `.classList.add/remove('hidden')` 전환:
```js
// 이전
addServiceModal.style.display = 'flex';
// 이후
addServiceModal.classList.remove('hidden');
```

영향 요소: `#add-service-modal`, `#service-content`, `#analysis-panel`,
`#modal-empty`, `#modal-module-list`, `#modal-footer`

---

## 3. 성능/안정성: 메모리 누수 전면 수정 (`SpringBootService.ts`)

서비스 재시작을 반복할 때 메모리가 선형으로 증가하는 문제 4건을 수정.

### 3-1. readline 인터페이스 미닫힘 → `_createRl()` / `_closeReadlines()`

**문제**: `readline.createInterface()`로 생성한 인터페이스를 저장하지 않아
프로세스 종료 후에도 GC 되지 않고 누적됨 (재시작마다 2개씩 누수).

**해결**:
```typescript
// 생성 시 목록에 등록
private _createRl(stream): readline.Interface {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  this.readlineInterfaces.push(rl);
  return rl;
}
// 프로세스 exit / stop() / dispose() 에서 일괄 닫기
private _closeReadlines(): void {
  for (const rl of this.readlineInterfaces) { rl.close(); }
  this.readlineInterfaces = [];
}
```

### 3-2. LogParser 이벤트 리스너 누적 → `_resetLogParser()`

**문제**: `start()` 호출마다 `new LogParser()` 생성 후 이전 인스턴스의
이벤트 리스너가 제거되지 않아 재시작 N회 → LogParser N개가 메모리에 잔류.

**해결**:
```typescript
private _resetLogParser(): LogParser {
  if (this.logParser) {
    this.logParser.flush();
    this.logParser.removeAllListeners(); // 이전 리스너 완전 제거
    this.logParser = null;
  }
  this.logParser = new LogParser(this.id);
  return this.logParser;
}
```

### 3-3. `_logs` 배열 `shift()` O(n) → `CircularBuffer<T>` O(1)

**문제**: 로그 500줄 제한을 위해 `_logs.shift()`를 매 로그마다 호출.
500개 요소를 매번 앞에서 삭제하는 O(n) 연산이 반복됨.

**해결**: 인덱스 기반 원형 버퍼 클래스 도입:
```typescript
class CircularBuffer<T> {
  push(item: T): void { ... }  // O(1)
  toArray(): T[] { ... }       // 시간순 정렬 배열 반환
  clear(): void { ... }
}

private readonly _logBuf = new CircularBuffer<{ line: string; level: string }>(MAX_LOG_LINES);
```

### 3-4. Windows `_killProcess()` 개선

**문제**:
- `taskkill` 완료를 기다리지 않고 즉시 `this.springProcess = null` 처리
- `pid` 없을 때 예외 처리 누락
- `taskkill` 자체 실패 시 에러 핸들러 없음

**해결**:
```typescript
private _killProcess(): void {
  const proc = this.springProcess;
  this.springProcess = null; // 중복 kill 방지를 위해 먼저 해제
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' });
    killer.on('error', () => {}); // taskkill 없을 경우 무시
  } else {
    proc.kill('SIGTERM');
    // 5초 후 SIGKILL 에스컬레이션
    const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
    proc.once('exit', () => clearTimeout(timer));
  }
}
```

---

## 변경 파일 목록

| 파일 | 변경 내용 |
|---|---|
| `src/services/SpringBootService.ts` | JDT 실행 모드, `CircularBuffer`, readline/LogParser 메모리 누수 수정, Windows kill 개선 |
| `src/services/ServiceManager.ts` | `useJdt` 설정 읽기, `detectModulesWithLog()`, Maven parent pom 제외, 탐지 조건 완화 |
| `src/webview/WebviewProvider.ts` | 인라인 `style=` 제거 → `.hidden` 클래스, `detectAndSendModules()` 스캔 로그 전송 |
| `src/webview/script.js` | `.style.display` → `classList`, `openAddServiceModal` 완전 상태 초기화 |
| `src/webview/style.css` | `.hidden`, `.modal-empty-hint`, `.detect-log` 클래스 추가 |
| `src/types/index.ts` | `DetectModulesResult`에 `workspaceInfo?: string` 추가 |
| `package.json` | `springErrorAnalyzer.useJdt` 설정 항목 추가 |

---

## 빌드 방법

```bash
npm run compile
npx vsce package --allow-missing-repository --allow-star-activation
```
