import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { LogParser } from '../analyzer/LogParser';
import { LocalAnalyzer } from '../analyzer/LocalAnalyzer';
import { ClaudeAnalyzer } from '../analyzer/ClaudeAnalyzer';
import {
  ServiceInfo,
  ServiceStatus,
  AnalysisResult,
  ErrorBlock,
} from '../types';

const MAX_LOG_LINES = 500;

export class SpringBootService extends EventEmitter {
  private springProcess: ChildProcess | null = null;
  private logParser: LogParser | null = null;
  private readonly localAnalyzer = new LocalAnalyzer();
  private readonly claudeAnalyzer = new ClaudeAnalyzer();

  private _status: ServiceStatus = 'idle';
  private _errors: ErrorBlock[] = [];
  private _analyses: AnalysisResult[] = [];
  private _logs: Array<{ line: string; level: string }> = [];

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly modulePath: string,
    public readonly buildTool: 'gradle' | 'maven',
    public readonly parentPath?: string,
    public readonly moduleName?: string
  ) {
    super();
  }

  get status(): ServiceStatus { return this._status; }
  get errors(): ErrorBlock[] { return this._errors; }
  get analyses(): AnalysisResult[] { return this._analyses; }
  get logs(): Array<{ line: string; level: string }> { return this._logs; }

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

  start(apiKey: string, model: string, maxRequestsPerMinute: number, profiles?: string, jvmArgs?: string): void {
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
    this._logs = [];
    this.claudeAnalyzer.configure(apiKey, model, maxRequestsPerMinute);

    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (profiles) { env.SPRING_PROFILES_ACTIVE = profiles; }
    if (jvmArgs) {
      if (this.buildTool === 'gradle') { env.JAVA_OPTS = jvmArgs; }
      else { env.MAVEN_OPTS = jvmArgs; }
    }

    // Multi-module Maven: 의존성 먼저 설치 후 실행
    if (this.moduleName && this.buildTool === 'maven') {
      this._installThenRun(env);
    } else {
      this._launchProcess(env);
    }
  }

  stop(): void {
    if (!this.springProcess) {
      this._updateStatus('stopped');
      return;
    }
    this.logParser?.flush();
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
    const result = await this.claudeAnalyzer.analyze(error);
    if (result) {
      this._analyses.push(result);
      this.emit('analysis-result', result);
    }
  }

  dispose(): void {
    this.logParser?.flush();
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

    installProcess.stdout && readline.createInterface({ input: installProcess.stdout })
      .on('line', (line) => this._log(line, 'INFO'));
    installProcess.stderr && readline.createInterface({ input: installProcess.stderr })
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

  private _launchProcess(env: Record<string, string>): void {
    const { cmd, args, cwd } = this._findExecutable();
    this._updateStatus('starting');
    this._log(`[spring-advisor] Starting: ${cmd} ${args.join(' ')} (cwd: ${cwd})`, 'INFO');

    this.logParser = new LogParser(this.id);
    this.logParser.on('error', (errorBlock: ErrorBlock) => {
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
      readline.createInterface({ input: this.springProcess.stdout }).on('line', (line) => {
        this._log(line, 'INFO');
        this.logParser?.parseLine(line);
        if (/Started \w+ in \d+[\.,]\d+ seconds/.test(line)) {
          this._updateStatus('running');
        }
      });
    }

    if (this.springProcess.stderr) {
      readline.createInterface({ input: this.springProcess.stderr }).on('line', (line) => {
        this._log(line, 'ERROR');
        this.logParser?.parseLine(line);
      });
    }

    this.springProcess.on('error', (err) => {
      this._log(`[spring-advisor] Process error: ${err.message}`, 'ERROR');
      this._updateStatus('error');
    });

    this.springProcess.on('exit', (code, signal) => {
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

    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(this.springProcess.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      this.springProcess.kill('SIGTERM');
      const timer = setTimeout(() => this.springProcess?.kill('SIGKILL'), 5000);
      this.springProcess.once('exit', () => clearTimeout(timer));
    }
    this.springProcess = null;
  }

  private _log(line: string, level: string): void {
    this._logs.push({ line, level });
    if (this._logs.length > MAX_LOG_LINES) { this._logs.shift(); }
    this.emit('log', line, level);
  }

  private _updateStatus(status: ServiceStatus): void {
    this._status = status;
    this.emit('status-change', status);
  }
}
