import * as fs from 'fs';
import * as path from 'path';

export interface StackFrameContext {
  className: string;
  methodName: string;
  fileName: string;
  lineNumber: number;
  filePath: string;
  codeSnippet: string;
}

// "at com.example.demo.service.UserService.findById(UserService.java:42)"
const STACK_FRAME_REGEX = /^\s*at\s+([\w.$]+)\.([\w$<>]+)\(([\w$]+\.(?:java|kt)):(\d+)\)$/;

// 프레임워크/라이브러리 내부 클래스 제외 (사용자 코드만 추출)
const SKIP_PREFIXES = [
  'org.springframework.',
  'org.hibernate.',
  'org.apache.',
  'java.',
  'javax.',
  'jakarta.',
  'sun.',
  'com.sun.',
  'jdk.',
  'org.aspectj.',
  'net.bytebuddy.',
  'cglib.',
  'com.zaxxer.',
  'io.netty.',
  'reactor.',
  'kotlin.',
];

const SOURCE_ROOTS = [
  'src/main/java',
  'src/main/kotlin',
  'src/test/java',
  'src/test/kotlin',
];

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'build', 'target', 'out',
  '.idea', '.gradle', 'dist', '.mvn',
]);

export class CodeContextExtractor {
  private readonly workspacePaths: string[];
  private readonly contextLines: number;

  /**
   * @param workspacePaths 소스 파일을 탐색할 디렉토리 목록 (modulePath, workspaceFolders 등)
   * @param contextLines   에러 라인 기준 위아래로 포함할 줄 수 (기본 20줄)
   */
  constructor(workspacePaths: string[], contextLines = 20) {
    this.workspacePaths = workspacePaths;
    this.contextLines = contextLines;
  }

  /**
   * 스택 트레이스 라인 배열에서 사용자 코드 프레임을 최대 3개 추출하여 반환.
   */
  extract(stackTrace: string[]): StackFrameContext[] {
    const results: StackFrameContext[] = [];
    const seen = new Set<string>();

    for (const line of stackTrace) {
      const match = line.match(STACK_FRAME_REGEX);
      if (!match) { continue; }

      const [, className, methodName, fileName, lineStr] = match;
      const lineNumber = parseInt(lineStr, 10);

      // 프레임워크 내부 제외
      if (SKIP_PREFIXES.some((p) => className.startsWith(p))) { continue; }

      // 중복 제거
      const key = `${className}:${lineNumber}`;
      if (seen.has(key)) { continue; }
      seen.add(key);

      const filePath = this.findSourceFile(className, fileName);
      if (!filePath) { continue; }

      const codeSnippet = this.readSnippet(filePath, lineNumber);
      if (!codeSnippet) { continue; }

      results.push({ className, methodName, fileName, lineNumber, filePath, codeSnippet });

      if (results.length >= 3) { break; }
    }

    return results;
  }

  /**
   * 클래스명과 파일명으로 소스 파일 절대 경로를 찾는다.
   * 1순위: 패키지 경로 직접 계산 (표준 레이아웃)
   * 2순위: 파일명으로 재귀 탐색 (비표준 레이아웃 폴백)
   */
  private findSourceFile(className: string, fileName: string): string | undefined {
    const packagePath = this.getPackagePath(className);

    for (const root of this.workspacePaths) {
      // 1순위: src/main/java/<package>/<FileName>
      for (const sourceRoot of SOURCE_ROOTS) {
        const candidate = path.join(root, sourceRoot, packagePath, fileName);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }

      // 2순위: 파일명으로 재귀 탐색
      const found = this.searchByName(root, fileName);
      if (found) { return found; }
    }

    return undefined;
  }

  /**
   * 클래스 전체 이름에서 패키지 경로를 추출한다.
   * 예: com.example.demo.service.UserService -> com/example/demo/service
   * 내부 클래스(UserService$Builder)도 동일하게 처리.
   */
  private getPackagePath(className: string): string {
    const parts = className.split('.');
    const packageParts: string[] = [];

    for (const part of parts) {
      // 첫 글자가 대문자이거나 '$'를 포함하면 클래스 이름 시작
      if (/^[A-Z]/.test(part) || part.includes('$')) {
        break;
      }
      packageParts.push(part);
    }

    return packageParts.join('/');
  }

  /**
   * 디렉토리를 재귀적으로 탐색하여 파일명으로 검색 (폴백용).
   */
  private searchByName(dir: string, fileName: string, depth = 0): string | undefined {
    if (depth > 8) { return undefined; }

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && entry.name === fileName) {
          return path.join(dir, entry.name);
        }
        if (
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !SKIP_DIRS.has(entry.name)
        ) {
          const found = this.searchByName(path.join(dir, entry.name), fileName, depth + 1);
          if (found) { return found; }
        }
      }
    } catch {
      // 접근 권한 없음 등 — 무시
    }

    return undefined;
  }

  /**
   * 파일에서 targetLine 기준으로 ±contextLines 줄을 읽어 포맷된 문자열로 반환.
   * 에러 발생 라인에는 '>>>' 마커를 표시한다.
   */
  private readSnippet(filePath: string, targetLine: number): string {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      const start = Math.max(0, targetLine - this.contextLines - 1);
      const end = Math.min(lines.length, targetLine + this.contextLines);

      return lines
        .slice(start, end)
        .map((line, i) => {
          const lineNum = start + i + 1;
          const marker = lineNum === targetLine ? '>>>' : '   ';
          return `${marker} ${String(lineNum).padStart(4)} | ${line}`;
        })
        .join('\n');
    } catch {
      return '';
    }
  }
}
