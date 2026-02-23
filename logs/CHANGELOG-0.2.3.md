# Spring Boot Error Analyzer - 변경 내용 요약

> 버전: `0.2.3` | 작업일: `2026-02-24`

---

## 개요

이번 버전은 **AI 분석 품질 향상**과 **UI/UX 개선**에 집중한 릴리스입니다.

- 스택 트레이스에서 소스 코드를 자동 추출해 Claude 프롬프트에 포함 → 라인별 분석 가능
- AI 분석 결과의 코드 블록을 시각적으로 강조 표시
- 로그 패널 너비를 마우스 드래그로 조절 가능, 에러 패널 기본 너비 축소

---

## 1. 신규 기능: 소스 코드 컨텍스트 기반 AI 분석

### 배경

기존 Claude 프롬프트는 에러 메시지와 스택 트레이스 텍스트만 전달.
실제 소스 코드 없이는 "이 메서드를 확인하세요" 수준의 일반적인 제안만 가능했음.

### 구현: `CodeContextExtractor.ts` (신규)

스택 트레이스 라인에서 파일명·라인 번호를 파싱하고,
워크스페이스에서 해당 `.java` / `.kt` 파일을 찾아 전후 20줄을 추출한다.

#### 파일 탐색 전략

```
at com.example.demo.service.UserService.findById(UserService.java:42)
        ↓ 파싱
className = com.example.demo.service.UserService
fileName  = UserService.java
lineNumber = 42
        ↓ 파일 탐색
1순위: src/main/java/com/example/demo/service/UserService.java  (패키지 경로 직접 계산)
2순위: 파일명 재귀 탐색 (비표준 레이아웃 폴백)
```

#### 제외 대상 (프레임워크 내부)

`org.springframework.*`, `org.hibernate.*`, `java.*`, `jakarta.*`, `sun.*` 등
→ 사용자 코드 프레임만 최대 3개 추출

#### 코드 스니펫 포맷

```
   0040 | public User findById(Long id) {
   0041 |   if (id == null) return null;
>>>  0042 |   return userRepository.getById(id);   ← 에러 발생 라인
   0043 | }
```

### 변경: `ClaudeAnalyzer.ts`

`analyze(error, codeContexts?)` 파라미터 추가.
코드 컨텍스트가 존재하면 프롬프트에 포함하고, 구체적인 라인 번호·변수명 참조를 지시한다.

```
관련 소스 코드 (에러 발생 위치, >>> 마커가 해당 라인):

[com.example.UserService.findById() - UserService.java:42]
```

### 변경: `SpringBootService.ts`

`requestAiAnalysis()` 에서 `claudeAnalyzer.analyze()` 호출 전
`codeContextExtractor.extract(error.stackTrace)` 를 먼저 실행.

```typescript
const codeContexts = this.codeContextExtractor.extract(error.stackTrace);
const result = await this.claudeAnalyzer.analyze(error, codeContexts);
```

### 변경: `types/index.ts`

```typescript
/** 스택 프레임에서 추출한 소스 코드 컨텍스트 (webview 표시용) */
export interface CodeContext {
  className: string;
  methodName: string;
  fileName: string;
  lineNumber: number;
  codeSnippet: string;
}

export interface AnalysisResult {
  // ... 기존 필드
  codeContexts?: CodeContext[]; // AI 분석 시만 포함
}
```

---

## 2. 신규 기능: AI 분석 결과 코드 블록 강조

### 배경

Claude가 제안 텍스트에 Java 코드를 백틱(`` ` ``) 없이 평문으로 반환하는 경우,
기존 코드는 전체를 단순 텍스트로 출력해 가독성이 낮았음.

### 구현: `script.js`

#### `isCodeLine(line)` — Java/Kotlin 코드 휴리스틱 감지

| 조건 | 예시 |
|---|---|
| 들여쓰기 라인 | `    return user;` |
| Java 키워드 시작 | `if (`, `throw `, `return`, `new`, `public` … |
| 중괄호만 있는 줄 | `}` |
| 세미콜론으로 끝남 | `auth.getAuthentication();` |
| 대문자 타입 선언 | `Authentication auth = …` |

#### `renderInlineMarkdown(text)` — 라인별 분류 렌더링

```
텍스트 줄   →  <p class="suggestion-text">...</p>
코드 줄들   →  <pre class="suggestion-code-block">...</pre>
인라인 백틱  →  <code class="inline-code">...</code>
```

우선순위: 명시적 ` ``` ` 블록 → 코드 패턴 자동 감지 → 인라인 백틱

#### `renderCodeSnippet(snippet)` — 소스 코드 테이블 렌더링

`>>>` 마커가 붙은 에러 발생 라인을 빨간 배경(`rgba(244, 67, 54, 0.18)`)으로 강조.

```html
<table class="code-snippet-table">
  <tr class="code-error-line">
    <td class="code-line-num">42</td>
    <td class="code-line-body">return userRepository.getById(id);</td>
  </tr>
</table>
```

#### `renderCodeContexts(contexts)` — 소스 코드 섹션 출력

AI 분석 결과에 `codeContexts` 가 있으면 "소스 코드" 섹션을 추가 렌더링.
메서드명은 노란색(에디터 심볼 색상), 파일 경로는 흐리게 표시.

### 변경: `style.css`

| 클래스 | 용도 |
|---|---|
| `.suggestion-code-block` | Solution 내 코드 블록 (어두운 배경, 모노스페이스) |
| `.inline-code` | 인라인 백틱 코드 (`#ce9178` 색상) |
| `.code-snippet-table` | 소스 코드 테이블 |
| `.code-line-num` | 라인 번호 칸 (회색) |
| `.code-error-line` | 에러 발생 라인 강조 (빨간 배경 + 숫자 빨간색) |
| `.code-context-method` | 메서드명 (`#dcdcaa`, 에디터 함수 색상) |

---

## 3. UI 개선: 로그 패널 너비 조절 + 에러 패널 축소

### 변경: 패널 레이아웃 (`style.css`)

기존 `gap: 12px` + 모든 패널 `flex: 1` (균등 분배) 에서 변경.

| 패널 | 이전 | 이후 |
|---|---|---|
| `#log-panel` | `flex: 1` | `flex: 1 1 0` (남은 공간 전부) |
| `#error-panel` | `flex: 1` | `flex: 0 0 210px` (고정 좁은 너비) |
| `#analysis-panel` | `flex: 1` | `flex: 1 1 0` (남은 공간 전부) |

### 변경: 리사이저 추가 (`WebviewProvider.ts`)

```html
<div id="log-panel" class="panel">...</div>
<div id="log-resizer" class="panel-resizer"
     title="드래그하여 너비 조절 · 더블클릭하여 초기화"></div>
<div id="error-panel" class="panel">...</div>
```

`.panel-resizer` 스타일:
- 기본: 4px 폭, `var(--border)` 색상 세로 구분선
- hover / 드래그 중: `var(--btn-bg)` 파란색으로 변경
- `::before` 투명 패딩으로 hover 영역 좌우 5px 확장

### 변경: 드래그 리사이즈 로직 (`script.js`)

```
mousedown  → 현재 log-panel 너비 기록, 드래그 시작
mousemove  → 새 너비 계산 후 logPanel.style.flex = '0 0 Xpx'
             (최소 150px, 최대 panels 전체 너비의 70%)
mouseup    → 드래그 종료
dblclick   → logPanel.style.flex = '1 1 0' (초기화)
```

---

## 변경 파일 목록

| 파일 | 변경 내용 |
|---|---|
| `src/analyzer/CodeContextExtractor.ts` | **신규** — 스택 트레이스 파싱 + 소스 파일 탐색 + 코드 스니펫 추출 |
| `src/analyzer/ClaudeAnalyzer.ts` | `analyze()` 에 `codeContexts` 파라미터 추가, 프롬프트 구성 변경, 결과에 `codeContexts` 포함 |
| `src/services/SpringBootService.ts` | `CodeContextExtractor` 초기화 및 `requestAiAnalysis()` 연동 |
| `src/types/index.ts` | `CodeContext` 인터페이스 추가, `AnalysisResult.codeContexts` 필드 추가 |
| `src/webview/WebviewProvider.ts` | `#log-resizer` div 추가 |
| `src/webview/script.js` | `isCodeLine()`, `renderInlineMarkdown()`, `renderCodeSnippet()`, `renderCodeContexts()` 추가, 패널 리사이즈 로직 추가 |
| `src/webview/style.css` | 패널 레이아웃 재구성, `.panel-resizer`, 코드 강조 스타일 클래스 추가 |

---

## 빌드 방법

```bash
npm run compile
npx vsce package --allow-missing-repository --allow-star-activation
```
