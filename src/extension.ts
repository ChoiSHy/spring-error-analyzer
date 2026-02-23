import * as vscode from 'vscode';
import { ServiceManager } from './services/ServiceManager';
import { WebviewProvider } from './webview/WebviewProvider';

let serviceManager: ServiceManager;
let webviewProvider: WebviewProvider;

export function activate(context: vscode.ExtensionContext): void {
  vscode.window.showInformationMessage("Extension Activated");
  serviceManager = new ServiceManager();
  webviewProvider = new WebviewProvider(context, serviceManager);

  // 하단 패널 WebviewView 등록
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      WebviewProvider.viewId,
      webviewProvider
      // retainContextWhenHidden 제거 → 패널이 숨겨지면 Chromium 프로세스 해제
      // 패널을 다시 열면 resolveWebviewView가 호출되고 extension이 상태를 재전송
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('springErrorAnalyzer.openDashboard', () => {
      webviewProvider.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('springErrorAnalyzer.startService', async () => {

      const modules = await serviceManager.detectModules();

      if (modules.length === 0) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const folderInfo = workspaceFolders
          ? workspaceFolders.map(f => f.uri.fsPath).join(', ')
          : '(없음)';
        vscode.window.showWarningMessage(
          `Spring Boot 모듈을 찾을 수 없습니다. 워크스페이스: ${folderInfo}`,
          '서비스 추가 패널 열기'
        ).then(action => {
          if (action === '서비스 추가 패널 열기') {
            webviewProvider.show();
          }
        });
        return;
      }

      const items = modules.map((m) => ({
        label: m.name,
        description: `${m.buildTool} - ${m.modulePath}`,
        module: m,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '실행할 Spring Boot 모듈을 선택하세요',
        canPickMany: true,
      });

      if (!selected || selected.length === 0) return;

      // Open dashboard
      webviewProvider.show();

      // Add and start each selected service
      for (const item of selected) {
        const service = await serviceManager.addService(item.module);
        serviceManager.startService(service.id);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('springErrorAnalyzer.stopService', async () => {
      const services = serviceManager.getServices();
      const running = services.filter(
        (s) => s.status === 'running' || s.status === 'starting'
      );

      if (running.length === 0) {
        vscode.window.showInformationMessage('실행 중인 서비스가 없습니다.');
        return;
      }

      const items = running.map((s) => ({
        label: s.name,
        description: s.status,
        serviceId: s.id,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '중지할 서비스를 선택하세요',
      });

      if (selected) {
        serviceManager.stopService(selected.serviceId);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('springErrorAnalyzer.stopAll', () => {
      serviceManager.stopAll();
      vscode.window.showInformationMessage('모든 서비스를 중지합니다.');
    })
  );

  // Check API key on activation
  const config = vscode.workspace.getConfiguration('springErrorAnalyzer');
  if (!config.get<string>('claudeApiKey')) {
    vscode.window
      .showInformationMessage(
        'Spring Error Analyzer: Claude API 키가 설정되지 않았습니다. AI 분석을 사용하려면 설정에서 API 키를 입력하세요.',
        '설정 열기'
      )
      .then((action) => {
        if (action === '설정 열기') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'springErrorAnalyzer.claudeApiKey'
          );
        }
      });
  }

  // Status Bar Button
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  statusBarItem.text = "$(flame) Spring Analyzer";
  statusBarItem.tooltip = "Open Spring Error Analyzer Dashboard";
  statusBarItem.command = "springErrorAnalyzer.openDashboard";
  statusBarItem.show();

  context.subscriptions.push(statusBarItem);

  // ── 에러 알림 & 상태바 카운터 ──────────────────────────────
  // 서비스별 총 에러 횟수 추적 (그룹화된 건수가 아닌 raw 발생 횟수)
  const errorCountMap = new Map<string, number>();

  function updateStatusBar(): void {
    const services = serviceManager.getServices();
    const runningCount = services.filter(s => s.status === 'running' || s.status === 'starting').length;
    const totalErrors = Array.from(errorCountMap.values()).reduce((a, b) => a + b, 0);

    let text = '$(flame) Spring';
    if (runningCount > 0) {
      text += ` $(pulse) ${runningCount}`;
    }
    if (totalErrors > 0) {
      text += ` $(error) ${totalErrors}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      statusBarItem.backgroundColor = undefined;
    }
    statusBarItem.text = text;
    statusBarItem.tooltip = `Spring Error Analyzer\n실행 중: ${runningCount}개 서비스\n감지된 에러: ${totalErrors}건\n클릭하여 대시보드 열기`;
  }

  serviceManager.on('error-detected', (serviceId: string) => {
    const prev = errorCountMap.get(serviceId) ?? 0;
    errorCountMap.set(serviceId, prev + 1);
    updateStatusBar();

    // 최초 에러 또는 5회 단위마다 알림 표시 (알림 폭탄 방지)
    const newCount = prev + 1;
    if (newCount === 1 || newCount % 5 === 0) {
      const svc = serviceManager.getServices().find(s => s.id === serviceId);
      const svcName = svc?.name ?? serviceId;
      vscode.window
        .showWarningMessage(
          `$(error) [${svcName}] 에러 ${newCount}건 감지됨`,
          '대시보드 열기'
        )
        .then(action => {
          if (action === '대시보드 열기') {
            webviewProvider.show();
          }
        });
    }
  });

  serviceManager.on('status-change', () => updateStatusBar());

  serviceManager.on('service-removed', (serviceId: string) => {
    errorCountMap.delete(serviceId);
    updateStatusBar();
  });
}

export function deactivate(): void {
  if (serviceManager) {
    serviceManager.stopAll();
    serviceManager.dispose();
  }
  if (webviewProvider) {
    webviewProvider.dispose();
  }
}

