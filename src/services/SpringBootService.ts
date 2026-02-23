import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { LogParser } from '../analyzer/LogParser';
import { LocalAnalyzer } from '../analyzer/LocalAnalyzer';
import { ClaudeAnalyzer } from '../analyzer/ClaudeAnalyzer';
import { CodeContextExtractor } from '../analyzer/CodeContextExtractor';
import {
  ServiceInfo,
  ServiceStatus,
  AnalysisResult,
  ErrorBlock,
} from '../types';

export type JdtMode = 'auto' | 'always' | 'never';

const MAX_LOG_LINES = 500;

/** O(1) 삽입/조회 원형 버퍼 */
class CircularBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0; // 다음 쓸 위치
  private _size = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this._size < this.capacity) { this._size++; }
  }

  toArray(): T[] {
    if (this._size < this.capacity) {
      return this.buf.slice(0, this._size) as T[];
    }
    // head가 가장 오래된 항목을 가리킴
    return [
      ...this.buf.slice(this.head) as T[],
      ...this.buf.slice(0, this.head) as T[],
    ];
  }

  get size(): number { return this._size; }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.head = 0;
    this._size = 0;
  }
}

export class SpringBootService extends EventEmitter {
  private springProcess: ChildProcess | null = null;
  private logParser: LogParser | null = null;
  /** 열린 readline 인터페이스 목록 — 프로세스 종료 시 일괄 close() */
  private readlineInterfaces: readline.Interface[] = [];
  private readonly localAnalyzer = new LocalAnalyzer();
  private readonly claudeAnalyzer = new ClaudeAnalyzer();
  private readonly codeContextExtractor: CodeContextExtractor;

  private _status: ServiceStatus = 'idle';
  private _errors: ErrorBlock[] = [];
  private _analyses: AnalysisResult[] = [];
  private readonly _logBuf = new CircularBuffer<{ line: string; level: string }>(MAX_LOG_LINES);

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly modulePath: string,
    public readonly buildTool: 'gradle' | 'maven',
    public readonly parentPath?: string,
    public readonly moduleName?: string
  ) {
    super();
    // 소스 코드 탐색 경로: modulePath + 워크스페이스 폴더 전체
    const workspacePaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const searchPaths = [this.modulePath, ...workspacePaths.filter((p) => p !== this.modulePath)];
    this.codeContextExtractor = new CodeContextExtractor(searchPaths);
  }

  get status(): ServiceStatus { return this._status; }
  get errors(): ErrorBlock[] { return this._errors; }
  get analyses(): AnalysisResult[] { return this._analyses; }
  get logs(): Array<{ line: string; level: string }> { return this._logBuf.toArray(); }

  getInfo(): ServiceInfo {
    return {
      id: this.id,
      name: this.name,
      modulePath: this.modulePath,
      status: this._status,
      command: this.buildTool === 'gradle' ? 'auto-gradle' : 'auto-maven',
      buildTool: this.buildTool,
    };
  }

  configure(apiKey: string, model: string, maxRequestsPerMinute: number): void {
    this.claudeAnalyzer.configure(apiKey, model, maxRequestsPerMinute);
  }

  start(
    apiKey: string,
    model: string,
    maxRequestsPerMinute: number,
    profiles?: string,
    jvmArgs?: string,
    useJdt: JdtMode = 'auto'
  ): void {
    // 이미 실행 중이면 무시
    if (this.springProcess && (this._status === 'starting' || this._status === 'running')) {
      return;
    }
    // 이전 프로세스 정리
    if (this.springProcess) {
      this._killProcess();
    }

    this._errors = [];
    this._analyses = [];
    this._logBuf.clear();
    this.claudeAnalyzer.configure(apiKey, model, maxRequestsPerMinute);

    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (profiles) { env.SPRING_PROFILES_ACTIVE = profiles; }
    if (jvmArgs) {
      if (this.buildTool === 'gradle') { env.JAVA_OPTS = jvmArgs; }
      else { env.MAVEN_OPTS = jvmArgs; }
    }

    // JDT 사용 여부 결정
    const shouldUseJdt = this._resolveJdtMode(useJdt);

    if (shouldUseJdt) {
      this._launchWithJdt(env, jvmArgs);
    } else if (this.moduleName && this.buildTool === 'maven') {
      // Multi-module Maven: 의존성 먼저 설치 후 실행
      this._installThenRun(env);
    } else {
      this._launchProcess(env);
    }
  }

  /** JDT 모드 결정 (auto이면 redhat.java 활성화 여부로 판단) */
  private _resolveJdtMode(mode: JdtMode): boolean {
    if (mode === 'never') { return false; }
    if (mode === 'always') { return true; }
    // auto: redhat.java가 설치·활성화된 경우에만 JDT 사용
    const javaExt = vscode.extensions.getExtension('redhat.java');
    return !!(javaExt?.isActive);
  }

  /**
   * redhat.java Language Server가 완전히 준비될 때까지 대기.
   * 1) redhat.java exports의 onReady() 사용 (가장 안정적)
   * 2) 없으면 java.execute.workspaceCommand 폴링으로 폴백
   * 최대 30초 대기 후 타임아웃.
   */
  private async _waitForJdtReady(timeoutMs = 30000): Promise<boolean> {
    const javaExt = vscode.extensions.getExtension('redhat.java');
    if (!javaExt) { return false; }

    // 방법 1: exports.onReady() — redhat.java가 공식 제공하는 API
    try {
      const api = javaExt.exports as { onReady?: () => Promise<void> } | undefined;
      if (typeof api?.onReady === 'function') {
        this._log('[spring-advisor] JDT 서버 준비 대기 중 (onReady)...', 'INFO');
        await Promise.race([
          api.onReady(),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
        ]);
        this._log('[spring-advisor] JDT 서버 준비 완료', 'INFO');
        return true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'timeout') {
        this._log('[spring-advisor] JDT onReady 타임아웃 (30초)', 'WARN');
        return false;
      }
      // onReady 없음 → 폴링 방식으로 폴백
    }

    // 방법 2: java.execute.workspaceCommand 폴링 (구버전 호환)
    const pollInterval = 1500;
    const maxAttempts = Math.ceil(timeoutMs / pollInterval);
    this._log('[spring-advisor] JDT 서버 초기화 대기 중 (폴링)...', 'INFO');

    for (let i = 0; i < maxAttempts; i++) {
      try {
        await vscode.commands.executeCommand(
          'java.execute.workspaceCommand',
          'java.project.getClasspaths',
          vscode.Uri.file(this.modulePath).toString(),
          JSON.stringify({ scope: 'runtime' })
        );
        this._log('[spring-advisor] JDT 서버 준비 완료 (폴링 확인)', 'INFO');
        return true;
      } catch {
        // 아직 준비 안 됨
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
    }

    this._log('[spring-advisor] JDT 서버 초기화 타임아웃 (30초)', 'WARN');
    return false;
  }

  stop(): void {
    if (!this.springProcess) {
      this._closeReadlines();
      this._updateStatus('stopped');
      return;
    }
    this.logParser?.flush();
    this._closeReadlines();
    this._killProcess();
  }

  async requestAiAnalysis(error: ErrorBlock): Promise<void> {
    if (!this.claudeAnalyzer.isConfigured()) {
      const result: AnalysisResult = {
        errorId: error.id,
        serviceId: error.serviceId,
        analysisType: 'ai',
        title: 'AI 분석 불가',
        description: 'Claude API 키가 설정되지 않았습니다.',
        suggestion: '설정(springErrorAnalyzer.claudeApiKey)에서 API 키를 입력해주세요.',
        confidence: 0,
        timestamp: new Date().toISOString(),
        errorBlock: error,
      };
      this._analyses.push(result);
      this.emit('analysis-result', result);
      return;
    }
    const codeContexts = this.codeContextExtractor.extract(error.stackTrace);
    const result = await this.claudeAnalyzer.analyze(error, codeContexts);
    if (result) {
      this._analyses.push(result);
      this.emit('analysis-result', result);
    }
  }

  dispose(): void {
    this.logParser?.flush();
    this.logParser?.removeAllListeners();
    this._closeReadlines();
    this._killProcess();
    this.removeAllListeners();
  }

  // ── Private ────────────────────────────────────────────────

  private _findExecutable(): { cmd: string; args: string[]; cwd: string } {
    const isWindows = process.platform === 'win32';
    const searchDirs = this.parentPath ? [this.parentPath, this.modulePath] : [this.modulePath];

    if (this.buildTool === 'gradle') {
      for (const dir of searchDirs) {
        const wrapper = path.join(dir, isWindows ? 'gradlew.bat' : 'gradlew');
        if (fs.existsSync(wrapper)) {
          const args = this.moduleName ? [`:${this.moduleName}:bootRun`] : ['bootRun'];
          return { cmd: wrapper, args, cwd: dir };
        }
      }
      const args = this.moduleName ? [`:${this.moduleName}:bootRun`] : ['bootRun'];
      return { cmd: 'gradle', args, cwd: this.parentPath || this.modulePath };
    } else {
      for (const dir of searchDirs) {
        const wrapper = path.join(dir, isWindows ? 'mvnw.cmd' : 'mvnw');
        if (fs.existsSync(wrapper)) {
          const args = this.moduleName ? ['-pl', this.moduleName, 'spring-boot:run'] : ['spring-boot:run'];
          return { cmd: wrapper, args, cwd: dir };
        }
      }
      const args = this.moduleName ? ['-pl', this.moduleName, 'spring-boot:run'] : ['spring-boot:run'];
      return { cmd: 'mvn', args, cwd: this.parentPath || this.modulePath };
    }
  }

  private _installThenRun(env: Record<string, string>): void {
    const { cmd, cwd } = this._findExecutable();
    this._log(`[spring-advisor] Installing dependencies for ${this.moduleName}...`, 'INFO');

    const installArgs = ['-pl', this.moduleName!, '-am', 'install', '-DskipTests', '-q'];
    const installProcess = spawn(cmd, installArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    installProcess.stdout && this._createRl(installProcess.stdout)
      .on('line', (line) => this._log(line, 'INFO'));
    installProcess.stderr && this._createRl(installProcess.stderr)
      .on('line', (line) => this._log(line, 'ERROR'));

    installProcess.on('exit', (code) => {
      if (code !== 0) {
        this._log(`[spring-advisor] Install failed (exit ${code}). Trying anyway...`, 'WARN');
      } else {
        this._log(`[spring-advisor] Dependencies installed. Starting ${this.moduleName}...`, 'INFO');
      }
      this._launchProcess(env);
    });
  }

  /**
   * JDT Language Server를 활용한 빠른 실행.
   * redhat.java가 제공하는 java.project.getClasspaths 커맨드로 클래스패스를 얻고,
   * vscode.java.resolveMainClass로 메인 클래스를 찾아 java -cp ... MainClass로 직접 실행.
   * JDT 실패 시 bootRun으로 자동 폴백.
   */
  private async _launchWithJdt(env: Record<string, string>, jvmArgs?: string): Promise<void> {
    this._updateStatus('starting');
    this._log('[spring-advisor] JDT 방식으로 실행 시도 중...', 'INFO');

    try {
      // 0. JDT Language Server 준비 대기
      const ready = await this._waitForJdtReady();
      if (!ready) {
        this._log('[spring-advisor] JDT 서버가 준비되지 않았습니다. bootRun으로 폴백합니다.', 'WARN');
        this._fallbackToBootRun(env);
        return;
      }

      // 1. 메인 클래스 목록 조회
      // resolveMainClass는 fsPath(raw) 또는 URI 문자열을 받을 수 있음
      // Windows 경로(c:\...)는 URI로 해석 시 오류 → vscode.Uri.file()로 변환해서 전달
      const moduleUri = vscode.Uri.file(this.modulePath);
      const mainClasses: Array<{ mainClass: string; projectName: string; filePath: string }> =
        await vscode.commands.executeCommand(
          'java.execute.workspaceCommand',
          'vscode.java.resolveMainClass',
          moduleUri.toString()
        ) ?? [];

      if (mainClasses.length === 0) {
        this._log('[spring-advisor] JDT: 메인 클래스를 찾을 수 없습니다. bootRun으로 폴백합니다.', 'WARN');
        this._fallbackToBootRun(env);
        return;
      }

      // Spring Boot 메인 클래스 우선 선택 (Application으로 끝나는 것)
      const mainClassEntry =
        mainClasses.find((m) => m.mainClass.endsWith('Application')) ?? mainClasses[0];
      const mainClass = mainClassEntry.mainClass;
      const projectName = mainClassEntry.projectName;

      this._log(`[spring-advisor] JDT: 메인 클래스 발견 → ${mainClass}`, 'INFO');

      // 2. 클래스패스 조회 (위에서 선언한 moduleUri 재사용)
      const classpathResult: { classpaths: string[]; modulepaths: string[] } | undefined =
        await vscode.commands.executeCommand(
          'java.execute.workspaceCommand',
          'java.project.getClasspaths',
          moduleUri.toString(),
          JSON.stringify({ scope: 'runtime', projectName })
        );

      if (!classpathResult || classpathResult.classpaths.length === 0) {
        this._log('[spring-advisor] JDT: 클래스패스를 가져올 수 없습니다. bootRun으로 폴백합니다.', 'WARN');
        this._fallbackToBootRun(env);
        return;
      }

      const classpathSeparator = process.platform === 'win32' ? ';' : ':';
      const classpath = classpathResult.classpaths.join(classpathSeparator);

      // 3. java -cp ... MainClass 직접 실행
      const javaArgs: string[] = [];
      if (jvmArgs) {
        javaArgs.push(...jvmArgs.split(/\s+/).filter(Boolean));
      }
      javaArgs.push('-cp', classpath, mainClass);

      this._log(`[spring-advisor] JDT: java ${javaArgs.slice(0, 3).join(' ')} ... (classpath 생략)`, 'INFO');

      this._spawnJavaProcess('java', javaArgs, this.modulePath, env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`[spring-advisor] JDT 실행 실패: ${msg} → bootRun으로 폴백합니다.`, 'WARN');
      this._fallbackToBootRun(env);
    }
  }

  /** JDT 실패 시 bootRun 폴백 */
  private _fallbackToBootRun(env: Record<string, string>): void {
    if (this.moduleName && this.buildTool === 'maven') {
      this._installThenRun(env);
    } else {
      this._launchProcess(env);
    }
  }

  /** java 커맨드로 프로세스를 직접 실행 (JDT 전용) */
  private _spawnJavaProcess(cmd: string, args: string[], cwd: string, env: Record<string, string>): void {
    const parser = this._resetLogParser();
    parser.on('error', (errorBlock: ErrorBlock) => {
      this._errors.push(errorBlock);
      this.emit('error-detected', errorBlock);

      if (this.localAnalyzer.canHandle(errorBlock)) {
        const result = this.localAnalyzer.analyze(errorBlock);
        if (result) {
          this._analyses.push(result);
          this.emit('analysis-result', result);
        }
      }
    });

    try {
      this.springProcess = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false, // java는 shell 불필요
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._log(`[spring-advisor] JDT java 실행 실패: ${message}`, 'ERROR');
      this._updateStatus('error');
      return;
    }

    if (this.springProcess.stdout) {
      this._createRl(this.springProcess.stdout).on('line', (line) => {
        this._log(line, 'INFO');
        this.logParser?.parseLine(line);
        if (/Started \w+ in \d+[\.,]\d+ seconds/.test(line)) {
          this._updateStatus('running');
        }
      });
    }

    if (this.springProcess.stderr) {
      this._createRl(this.springProcess.stderr).on('line', (line) => {
        this._log(line, 'ERROR');
        this.logParser?.parseLine(line);
      });
    }

    this.springProcess.on('error', (err) => {
      this._log(`[spring-advisor] Process error: ${err.message}`, 'ERROR');
      this._updateStatus('error');
    });

    this.springProcess.on('exit', (code, signal) => {
      this._closeReadlines();
      this.logParser?.flush();
      this.springProcess = null;
      if (code === 0 || signal === 'SIGTERM') {
        this._updateStatus('stopped');
      } else {
        this._updateStatus('error');
      }
    });
  }

  private _launchProcess(env: Record<string, string>): void {
    const { cmd, args, cwd } = this._findExecutable();
    this._updateStatus('starting');
    this._log(`[spring-advisor] Starting: ${cmd} ${args.join(' ')} (cwd: ${cwd})`, 'INFO');

    const parser = this._resetLogParser();
    parser.on('error', (errorBlock: ErrorBlock) => {
      this._errors.push(errorBlock);
      this.emit('error-detected', errorBlock);

      // 로컬 분석 즉시 실행 (동기, 블로킹 없음)
      if (this.localAnalyzer.canHandle(errorBlock)) {
        const result = this.localAnalyzer.analyze(errorBlock);
        if (result) {
          this._analyses.push(result);
          this.emit('analysis-result', result);
        }
      }
    });

    try {
      this.springProcess = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._log(`[spring-advisor] Failed to start: ${message}`, 'ERROR');
      this._updateStatus('error');
      return;
    }

    if (this.springProcess.stdout) {
      this._createRl(this.springProcess.stdout).on('line', (line) => {
        this._log(line, 'INFO');
        this.logParser?.parseLine(line);
        if (/Started \w+ in \d+[\.,]\d+ seconds/.test(line)) {
          this._updateStatus('running');
        }
      });
    }

    if (this.springProcess.stderr) {
      this._createRl(this.springProcess.stderr).on('line', (line) => {
        this._log(line, 'ERROR');
        this.logParser?.parseLine(line);
      });
    }

    this.springProcess.on('error', (err) => {
      this._log(`[spring-advisor] Process error: ${err.message}`, 'ERROR');
      this._updateStatus('error');
    });

    this.springProcess.on('exit', (code, signal) => {
      this._closeReadlines();
      this.logParser?.flush();
      this.springProcess = null;

      if (code === 0 || signal === 'SIGTERM') {
        this._updateStatus('stopped');
      } else {
        this._updateStatus('error');
      }
    });
  }

  private _killProcess(): void {
    if (!this.springProcess) { return; }
    const proc = this.springProcess;
    this.springProcess = null; // 참조 먼저 해제해 중복 kill 방지

    if (process.platform === 'win32') {
      const pid = proc.pid;
      if (pid) {
        // taskkill /f /t: 프로세스 트리 전체 강제 종료
        // 완료를 기다리되 실패해도 무시
        const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' });
        killer.on('error', () => { /* taskkill 없을 경우 무시 */ });
      } else {
        try { proc.kill(); } catch { /* ignore */ }
      }
    } else {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 5000);
      proc.once('exit', () => clearTimeout(timer));
    }
  }

  private _log(line: string, level: string): void {
    this._logBuf.push({ line, level });
    this.emit('log', line, level);
  }

  /** readline 인터페이스를 생성하고 목록에 등록 (종료 시 일괄 close) */
  private _createRl(stream: NodeJS.ReadableStream): readline.Interface {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    this.readlineInterfaces.push(rl);
    return rl;
  }

  /** 열린 readline 인터페이스를 모두 닫고 목록 초기화 */
  private _closeReadlines(): void {
    for (const rl of this.readlineInterfaces) {
      try { rl.close(); } catch { /* ignore */ }
    }
    this.readlineInterfaces = [];
  }

  /** LogParser를 교체 (이전 리스너 완전 제거 후 새 인스턴스 생성) */
  private _resetLogParser(): LogParser {
    if (this.logParser) {
      this.logParser.flush();
      this.logParser.removeAllListeners();
      this.logParser = null;
    }
    this.logParser = new LogParser(this.id);
    return this.logParser;
  }

  private _updateStatus(status: ServiceStatus): void {
    this._status = status;
    this.emit('status-change', status);
  }
}
