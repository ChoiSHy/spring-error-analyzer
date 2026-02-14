import { fork, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import {
  ServiceInfo,
  ServiceStatus,
  ParentToChildMessage,
  ChildToParentMessage,
  AnalysisResult,
  ErrorBlock,
} from '../types';

export class SpringBootService extends EventEmitter {
  private worker: ChildProcess | null = null;
  private _status: ServiceStatus = 'idle';
  private _errors: ErrorBlock[] = [];
  private _analyses: AnalysisResult[] = [];

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly modulePath: string,
    public readonly buildTool: 'gradle' | 'maven',
    public readonly parentPath?: string,   // Multi-module: root directory
    public readonly moduleName?: string    // Multi-module: -pl module name
  ) {
    super();
  }

  get status(): ServiceStatus {
    return this._status;
  }

  get errors(): ErrorBlock[] {
    return this._errors;
  }

  get analyses(): AnalysisResult[] {
    return this._analyses;
  }

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

  start(apiKey: string, model: string, maxRequestsPerMinute: number, profiles?: string, jvmArgs?: string): void {
    // If the worker is alive but Spring Boot has stopped/errored, kill the old worker first
    if (this.worker && (this._status === 'stopped' || this._status === 'error' || this._status === 'idle')) {
      this.worker.kill();
      this.worker = null;
    }

    if (this.worker) {
      // Still running or starting — ignore duplicate start
      return;
    }

    this._errors = [];
    this._analyses = [];

    const workerPath = path.join(__dirname, 'analyzerWorker.js');

    this.worker = fork(workerPath, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });

    this.worker.on('message', (msg: ChildToParentMessage) => {
      this.handleWorkerMessage(msg);
    });

    this.worker.on('error', (err) => {
      this.updateStatus('error');
      this.emit('workerError', err);
    });

    this.worker.on('exit', (code) => {
      this.worker = null;
      if (this._status !== 'stopped' && this._status !== 'error') {
        this.updateStatus(code === 0 ? 'stopped' : 'error');
      }
    });

    // Configure Claude API first
    this.sendToWorker({
      type: 'configure',
      apiKey,
      model,
      maxRequestsPerMinute,
    });

    // Build environment with profiles and JVM args
    const env: Record<string, string> = {};
    if (profiles) {
      env.SPRING_PROFILES_ACTIVE = profiles;
    }
    if (jvmArgs) {
      if (this.buildTool === 'gradle') {
        env.JAVA_OPTS = jvmArgs;
      } else {
        env.MAVEN_OPTS = jvmArgs;
      }
    }

    // Start Spring Boot
    this.sendToWorker({
      type: 'start',
      modulePath: this.modulePath,
      parentPath: this.parentPath,
      moduleName: this.moduleName,
      command: this.buildTool === 'gradle' ? 'auto-gradle' : 'auto-maven',
      env: Object.keys(env).length > 0 ? env : undefined,
      serviceId: this.id,
      serviceName: this.name,
    });
  }

  stop(): void {
    if (this.worker) {
      this.sendToWorker({ type: 'stop' });
    }
  }

  requestAiAnalysis(error: ErrorBlock): void {
    this.sendToWorker({ type: 'analyze-error', error });
  }

  dispose(): void {
    if (this.worker) {
      this.worker.kill();
      this.worker = null;
    }
    this.removeAllListeners();
  }

  private sendToWorker(msg: ParentToChildMessage): void {
    if (this.worker?.connected) {
      this.worker.send(msg);
    }
  }

  private handleWorkerMessage(msg: ChildToParentMessage): void {
    switch (msg.type) {
      case 'status-change':
        this.updateStatus(msg.status);
        break;

      case 'spring-log':
        this.emit('log', msg.line, msg.level);
        break;

      case 'error-detected':
        this._errors.push(msg.error);
        this.emit('error-detected', msg.error);
        break;

      case 'analysis-result':
        this._analyses.push(msg.result);
        this.emit('analysis-result', msg.result);
        break;
    }
  }

  private updateStatus(status: ServiceStatus): void {
    this._status = status;
    this.emit('status-change', status);
  }
}
