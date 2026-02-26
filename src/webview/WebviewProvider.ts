import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { ServiceManager } from '../services/ServiceManager';
import {
  WebviewToExtensionMessage,
  ExtensionToWebviewMessage,
  ServiceStatus,
  ErrorBlock,
  AnalysisResult,
  SnapshotLoad,
  DetectedModuleInfo,
} from '../types';

export class WebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'springErrorAnalyzer.panel';

  private _view: vscode.WebviewView | null = null;
  private readonly extensionUri: vscode.Uri;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly serviceManager: ServiceManager
  ) {
    this.extensionUri = context.extensionUri;
    this.setupServiceManagerListeners();
  }

  /** VSCode가 뷰를 생성/재생성할 때 자동 호출 */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
      ],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewToExtensionMessage) => this.handleWebviewMessage(msg),
      undefined,
      this.context.subscriptions
    );

    webviewView.onDidDispose(() => {
      this._view = null;
    });

  }

  private sendSnapshot(): void {
    const snapshots = this.serviceManager.getSnapshots();
    // 서비스 유무에 관계없이 항상 snapshotLoad로 전송
    // → webview가 항상 동일한 경로로 상태를 복원하므로 "빈 목록 덮어쓰기" 버그 없음
    const msg: SnapshotLoad = {
      type: 'snapshotLoad',
      snapshots,
      activeServiceId: snapshots.length > 0 ? snapshots[0].service.id : '',
    };
    this.postMessage(msg);
  }

  /** 하단 패널의 Spring Error Analyzer 탭을 포커스 */
  show(): void {
    vscode.commands.executeCommand('springErrorAnalyzer.panel.focus');
  }

  dispose(): void {
    this._view = null;
  }

  private postMessage(msg: ExtensionToWebviewMessage): void {
    if (this._view) {
      this._view.webview.postMessage(msg);
    }
  }

  private setupServiceManagerListeners(): void {
    this.serviceManager.on('status-change', (serviceId: string, status: ServiceStatus) => {
      this.postMessage({ type: 'serviceStatusUpdate', serviceId, status });
    });

    this.serviceManager.on('log', (serviceId: string, line: string, level: string) => {
      this.postMessage({ type: 'logUpdate', serviceId, line, level });
    });

    this.serviceManager.on('error-detected', (serviceId: string, error: ErrorBlock) => {
      this.postMessage({ type: 'errorUpdate', serviceId, error });
    });

    this.serviceManager.on('analysis-result', (_serviceId: string, result: AnalysisResult) => {
      this.postMessage({ type: 'analysisUpdate', result });
    });

    this.serviceManager.on('service-added', () => {
      this.postMessage({
        type: 'serviceListUpdate',
        services: this.serviceManager.getServices(),
      });
    });

    this.serviceManager.on('service-removed', () => {
      this.postMessage({
        type: 'serviceListUpdate',
        services: this.serviceManager.getServices(),
      });
    });
  }

  private handleWebviewMessage(msg: WebviewToExtensionMessage): void {
    switch (msg.type) {
      case 'webviewReady':
      case 'requestServiceList':
        // webview가 준비됐다고 알려오면 그때 snapshot 전송
        // → HTML 로딩 완료 후 확실히 수신됨
        this.sendSnapshot();
        break;

      case 'startService':
        this.serviceManager.startService(msg.serviceId);
        break;

      case 'startServiceDebug':
        this.serviceManager.startService(msg.serviceId, true);
        break;

      case 'stopService':
        this.serviceManager.stopService(msg.serviceId);
        break;

      case 'requestAiAnalysis':
        this.serviceManager.requestAiAnalysis(msg.serviceId, msg.error);
        break;

      case 'removeService':
        this.serviceManager.stopService(msg.serviceId);
        this.serviceManager.removeService(msg.serviceId);
        break;

      case 'killPort':
        this.killPort(msg.port, msg.serviceId);
        break;

      case 'requestDetectModules':
        this.detectAndSendModules();
        break;

      case 'addAndStartModules':
        this.addAndStartModules(msg.modulePaths);
        break;

      case 'startAllServices':
        this.serviceManager.startAll(false);
        break;

      case 'startAllServicesDebug':
        this.serviceManager.startAll(true);
        break;
    }
  }

  /** 워크스페이스 모듈 탐지 후 webview로 전송 */
  private async detectAndSendModules(): Promise<void> {
    const { modules: detected, log } = await this.serviceManager.detectModulesWithLog();
    const modules: DetectedModuleInfo[] = detected.map((m) => ({
      name: m.name,
      modulePath: m.modulePath,
      buildTool: m.buildTool,
      isMultiModule: !!m.parentPath,
    }));

    this.postMessage({ type: 'detectModulesResult', modules, workspaceInfo: log.join('\n') });
  }

  /** 선택된 modulePath 목록으로 서비스 추가 */
  private async addAndStartModules(modulePaths: string[]): Promise<void> {
    const detected = await this.serviceManager.detectModules();
    const targets = detected.filter((m) => modulePaths.includes(m.modulePath));

    // 대시보드 먼저 표시
    this.show();

    for (const module of targets) {
      await this.serviceManager.addService(module);
    }
  }

  /** 포트를 점유한 프로세스를 강제 종료 */
  private killPort(port: number, serviceId: string): void {
    const isWin = process.platform === 'win32';

    // 플랫폼별 PID 조회 명령
    const findCmd = isWin
      ? `netstat -ano | findstr ":${port} " | findstr "LISTENING"`
      : `lsof -ti tcp:${port}`;

    exec(findCmd, (err, stdout) => {
      const pid = isWin
        ? this.extractPidWindows(stdout)
        : stdout.trim().split('\n')[0].trim();

      if (!pid) {
        this.postMessage({
          type: 'portKillResult',
          port,
          success: false,
          message: `포트 ${port}를 점유한 프로세스를 찾을 수 없습니다.`,
        });
        return;
      }

      const killCmd = isWin ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`;
      exec(killCmd, (killErr) => {
        if (killErr) {
          this.postMessage({
            type: 'portKillResult',
            port,
            success: false,
            message: `포트 ${port} 프로세스(PID ${pid}) 종료 실패: ${killErr.message}`,
          });
        } else {
          this.postMessage({
            type: 'portKillResult',
            port,
            success: true,
            message: `포트 ${port} 프로세스(PID ${pid})를 종료했습니다. 서비스를 다시 시작하세요.`,
          });
          // 해당 서비스 재시작을 위해 상태를 stopped로 전환
          this.serviceManager.stopService(serviceId);
        }
      });
    });
  }

  /** Windows netstat 출력에서 PID 추출 */
  private extractPidWindows(stdout: string): string {
    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const last = parts[parts.length - 1]?.trim();
      if (last && /^\d+$/.test(last) && last !== '0') {
        return last;
      }
    }
    return '';
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const distWebview = path.join(this.extensionUri.fsPath, 'dist', 'webview');
    const srcWebview = path.join(this.extensionUri.fsPath, 'src', 'webview');

    // dist 우선(production), 없으면 src(development)
    const webviewDir = fs.existsSync(distWebview) ? distWebview : srcWebview;

    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(webviewDir, 'style.css'))
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(webviewDir, 'script.js'))
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Spring Error Analyzer</title>
</head>
<body>
  <div id="app">
    <header id="header">
      <div id="header-top">
        <h1>Spring Boot Error Analyzer</h1>
        <div id="header-actions">
          <button id="btn-start-all" class="btn btn-start" title="모든 서비스 시작">전체 시작</button>
          <button id="btn-debug-all" class="btn btn-debug" title="모든 서비스 디버그 시작">전체 DEBUG</button>
          <button id="btn-add-service" class="btn btn-add-service" title="서비스 추가">＋ 서비스 추가</button>
        </div>
      </div>
      <div id="service-tabs"></div>
    </header>
    <main id="main">
      <div id="no-services" class="placeholder">
        <p>실행할 Spring Boot 서비스를 추가하세요.</p>
        <button id="btn-add-service-empty" class="btn btn-add-service-empty">＋ 서비스 추가</button>
      </div>
      <div id="service-content" class="hidden">
        <div id="service-info">
          <span id="service-name"></span>
          <span id="service-status" class="badge"></span>
          <button id="btn-start" class="btn btn-start">Start</button>
          <button id="btn-debug" class="btn btn-debug" title="JDWP 디버그 모드로 실행">Debug</button>
          <button id="btn-stop" class="btn btn-stop">Stop</button>
        </div>
        <div id="panels">
          <div id="log-panel" class="panel">
            <div class="panel-header">
              <h2>Logs</h2>
              <button id="btn-clear-logs" class="btn btn-small">Clear</button>
            </div>
            <div class="log-toolbar">
              <input id="log-search" class="log-search" type="text" placeholder="검색..." />
              <div class="log-level-filters">
                <button class="btn-level active" data-level="ERROR">ERROR</button>
                <button class="btn-level active" data-level="WARN">WARN</button>
                <button class="btn-level active" data-level="INFO">INFO</button>
                <button class="btn-level active" data-level="DEBUG">DEBUG</button>
              </div>
              <span id="log-match-count" class="log-match-count"></span>
            </div>
            <div id="log-container" class="log-output"></div>
          </div>
          <div id="log-resizer" class="panel-resizer" title="드래그하여 너비 조절 · 더블클릭하여 초기화"></div>
          <div id="error-panel" class="panel">
            <h2>Errors <span id="error-count" class="badge badge-error">0</span></h2>
            <div id="error-list"></div>
          </div>
          <div id="analysis-panel" class="panel hidden">
            <div id="analysis-header">
              <h2>Analysis</h2>
              <button id="btn-close-analysis" class="btn btn-small">Close</button>
            </div>
            <div id="analysis-content"></div>
          </div>
        </div>
      </div>
    </main>
  </div>

  <!-- 서비스 추가 모달 -->
  <div id="add-service-modal" class="modal-overlay hidden">
    <div class="modal">
      <div class="modal-header">
        <h2>서비스 추가</h2>
        <button id="modal-close" class="modal-close-btn">×</button>
      </div>
      <div class="modal-body">
        <div id="modal-loading" class="modal-loading">
          <span class="modal-spinner"></span>
          <span>모듈 탐색 중...</span>
        </div>
        <div id="modal-empty" class="modal-empty hidden">
          <p>워크스페이스에서 Spring Boot 모듈을 찾을 수 없습니다.</p>
          <p class="modal-empty-hint">build.gradle 또는 pom.xml과 src/main 폴더가 있는지 확인하세요.</p>
        </div>
        <div id="modal-module-list" class="hidden">
          <p class="modal-hint">추가할 모듈을 선택하세요. (복수 선택 가능)</p>
          <div id="module-list-container" class="module-list"></div>
        </div>
      </div>
      <div class="modal-footer hidden" id="modal-footer">
        <span id="modal-selected-count" class="modal-selected-count">0개 선택됨</span>
        <button id="modal-cancel" class="btn btn-small">취소</button>
        <button id="modal-confirm" class="btn btn-start" disabled>추가</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
