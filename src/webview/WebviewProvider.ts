import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ServiceManager } from '../services/ServiceManager';
import {
  WebviewToExtensionMessage,
  ExtensionToWebviewMessage,
  ServiceStatus,
  ErrorBlock,
  AnalysisResult,
  SnapshotLoad,
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
    if (snapshots.length === 0) {
      // 서비스가 없으면 빈 목록 전송
      this.postMessage({ type: 'serviceListUpdate', services: [] });
      return;
    }

    const msg: SnapshotLoad = {
      type: 'snapshotLoad',
      snapshots,
      activeServiceId: snapshots[0].service.id,
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
    }
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
      <h1>Spring Boot Error Analyzer</h1>
      <div id="service-tabs"></div>
    </header>
    <main id="main">
      <div id="no-services" class="placeholder">
        <p>서비스가 없습니다.</p>
        <p>Command Palette에서 "Spring Error Analyzer: Start Service"를 실행하세요.</p>
      </div>
      <div id="service-content" style="display:none;">
        <div id="service-info">
          <span id="service-name"></span>
          <span id="service-status" class="badge"></span>
          <button id="btn-start" class="btn btn-start">Start</button>
          <button id="btn-stop" class="btn btn-stop">Stop</button>
        </div>
        <div id="panels">
          <div id="log-panel" class="panel">
            <div class="panel-header">
              <h2>Logs</h2>
              <button id="btn-clear-logs" class="btn btn-small">Clear</button>
            </div>
            <div id="log-container" class="log-output"></div>
          </div>
          <div id="error-panel" class="panel">
            <h2>Errors <span id="error-count" class="badge badge-error">0</span></h2>
            <div id="error-list"></div>
          </div>
          <div id="analysis-panel" class="panel" style="display:none;">
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
