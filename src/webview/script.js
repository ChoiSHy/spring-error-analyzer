// @ts-check

(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  /** @type {Array<{id: string, name: string, modulePath: string, status: string, command: string, buildTool: string}>} */
  let services = [];
  let activeServiceId = '';

  /** @type {Map<string, Array<{line: string, level: string}>>} */
  const logsMap = new Map();

  /** @type {Map<string, Array<any>>} */
  const errorsMap = new Map();

  /** @type {Map<string, any>} */
  const analysisMap = new Map();

  const MAX_LOG_LINES = 500;

  // DOM elements
  const serviceTabs = document.getElementById('service-tabs');
  const noServices = document.getElementById('no-services');
  const serviceContent = document.getElementById('service-content');
  const serviceName = document.getElementById('service-name');
  const serviceStatus = document.getElementById('service-status');
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const logContainer = document.getElementById('log-container');
  const errorCount = document.getElementById('error-count');
  const errorList = document.getElementById('error-list');
  const analysisPanel = document.getElementById('analysis-panel');
  const analysisContent = document.getElementById('analysis-content');
  const btnCloseAnalysis = document.getElementById('btn-close-analysis');
  const btnClearLogs = document.getElementById('btn-clear-logs');

  // Event listeners
  btnClearLogs?.addEventListener('click', () => {
    if (activeServiceId) {
      logsMap.set(activeServiceId, []);
      if (logContainer) logContainer.innerHTML = '';
    }
  });

  btnStart?.addEventListener('click', () => {
    if (activeServiceId) {
      vscode.postMessage({ type: 'startService', serviceId: activeServiceId });
    }
  });

  btnStop?.addEventListener('click', () => {
    if (activeServiceId) {
      vscode.postMessage({ type: 'stopService', serviceId: activeServiceId });
    }
  });

  btnCloseAnalysis?.addEventListener('click', () => {
    if (analysisPanel) analysisPanel.style.display = 'none';
  });

  // Message handler
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'serviceListUpdate':
        services = msg.services;
        renderTabs();
        if (!activeServiceId && services.length > 0) {
          selectService(services[0].id);
        }
        updateServiceView();
        break;

      case 'serviceStatusUpdate':
        updateServiceStatus(msg.serviceId, msg.status);
        break;

      case 'logUpdate':
        appendLog(msg.serviceId, msg.line, msg.level);
        break;

      case 'errorUpdate':
        appendError(msg.serviceId, msg.error);
        break;

      case 'analysisUpdate':
        storeAnalysis(msg.result);
        break;

      case 'snapshotLoad':
        loadSnapshot(msg.snapshots, msg.activeServiceId);
        break;
    }
  });

  function renderTabs() {
    if (!serviceTabs) return;
    serviceTabs.innerHTML = '';

    if (services.length === 0) {
      if (noServices) noServices.style.display = 'flex';
      if (serviceContent) serviceContent.style.display = 'none';
      return;
    }

    if (noServices) noServices.style.display = 'none';
    if (serviceContent) serviceContent.style.display = 'block';

    services.forEach((svc) => {
      const tab = document.createElement('div');
      tab.className = `service-tab ${svc.id === activeServiceId ? 'active' : ''}`;

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.innerHTML = `<span class="tab-status ${svc.status}"></span>${svc.name}`;
      label.addEventListener('click', () => selectService(svc.id));

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.title = '서비스 제거';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeService(svc.id);
      });

      tab.appendChild(label);
      tab.appendChild(closeBtn);
      serviceTabs.appendChild(tab);
    });
  }

  /**
   * 패널 재생성 시 extension으로부터 전체 상태를 한 번에 복원
   * logsMap / errorsMap / analysisMap 을 초기화하고 재구성
   */
  function loadSnapshot(snapshots, activeId) {
    // 기존 로컬 캐시 초기화
    logsMap.clear();
    errorsMap.clear();
    analysisMap.clear();

    // 서비스 목록 재구성
    services = snapshots.map((s) => s.service);
    activeServiceId = activeId || (services.length > 0 ? services[0].id : '');

    // 각 서비스의 로그 / 에러 / 분석 결과 복원
    snapshots.forEach((snap) => {
      logsMap.set(snap.service.id, snap.logs || []);
      errorsMap.set(snap.service.id, snap.errors || []);
      (snap.analyses || []).forEach((a) => analysisMap.set(a.errorId, a));
    });

    renderTabs();
    updateServiceView();
  }

  function selectService(id) {
    activeServiceId = id;
    renderTabs();
    updateServiceView();
  }

  function removeService(id) {
    // 로컬 캐시 정리
    logsMap.delete(id);
    errorsMap.delete(id);

    // 활성 탭이 제거된 경우 다른 탭으로 전환
    if (activeServiceId === id) {
      const remaining = services.filter((s) => s.id !== id);
      activeServiceId = remaining.length > 0 ? remaining[0].id : '';
    }

    // extension에 제거 요청
    vscode.postMessage({ type: 'removeService', serviceId: id });
  }

  function updateServiceView() {
    const svc = services.find((s) => s.id === activeServiceId);
    if (!svc) return;

    if (serviceName) serviceName.textContent = svc.name;
    updateStatusBadge(svc.status);
    updateButtons(svc.status);
    renderLogs();
    renderErrors();
  }

  function updateServiceStatus(serviceId, status) {
    const svc = services.find((s) => s.id === serviceId);
    if (svc) svc.status = status;

    renderTabs();
    if (serviceId === activeServiceId) {
      updateStatusBadge(status);
      updateButtons(status);
    }
  }

  function updateStatusBadge(status) {
    if (!serviceStatus) return;
    serviceStatus.textContent = status.toUpperCase();
    serviceStatus.className = `badge badge-${status}`;
  }

  function updateButtons(status) {
    if (btnStart) btnStart.disabled = status === 'starting' || status === 'running';
    if (btnStop) btnStop.disabled = status === 'idle' || status === 'stopped';
  }

  function appendLog(serviceId, line, level) {
    if (!logsMap.has(serviceId)) {
      logsMap.set(serviceId, []);
    }
    const logs = logsMap.get(serviceId);
    logs.push({ line, level });

    // Trim old logs
    if (logs.length > MAX_LOG_LINES) {
      logs.splice(0, logs.length - MAX_LOG_LINES);
    }

    if (serviceId === activeServiceId) {
      appendLogLine(line, level);
    }
  }

  function appendLogLine(line, level) {
    if (!logContainer) return;
    const div = document.createElement('div');
    div.className = `log-line ${level}`;
    div.textContent = line;
    logContainer.appendChild(div);

    // Auto-scroll
    logContainer.scrollTop = logContainer.scrollHeight;

    // Trim DOM nodes
    while (logContainer.children.length > MAX_LOG_LINES) {
      logContainer.removeChild(logContainer.firstChild);
    }
  }

  function renderLogs() {
    if (!logContainer) return;
    logContainer.innerHTML = '';
    const logs = logsMap.get(activeServiceId) || [];
    logs.forEach((l) => appendLogLine(l.line, l.level));
  }

  function appendError(serviceId, error) {
    if (!errorsMap.has(serviceId)) {
      errorsMap.set(serviceId, []);
    }
    errorsMap.get(serviceId).push(error);

    if (serviceId === activeServiceId) {
      renderErrors();
    }
  }

  function deleteError(serviceId, errorId) {
    const errors = errorsMap.get(serviceId);
    if (errors) {
      const idx = errors.findIndex((e) => e.id === errorId);
      if (idx !== -1) errors.splice(idx, 1);
    }
    analysisMap.delete(errorId);
    // Hide analysis panel if showing the deleted error
    if (analysisPanel && analysisPanel.dataset.errorId === errorId) {
      analysisPanel.style.display = 'none';
    }
    renderErrors();
  }

  function clearAllErrors(serviceId) {
    const errors = errorsMap.get(serviceId) || [];
    errors.forEach((e) => analysisMap.delete(e.id));
    errorsMap.set(serviceId, []);
    if (analysisPanel) analysisPanel.style.display = 'none';
    renderErrors();
  }

  function renderErrors() {
    if (!errorList || !errorCount) return;
    const errors = errorsMap.get(activeServiceId) || [];
    errorCount.textContent = String(errors.length);
    errorList.innerHTML = '';

    // "Clear All" button when there are errors
    if (errors.length > 0) {
      const clearBar = document.createElement('div');
      clearBar.className = 'error-clear-bar';
      const clearBtn = document.createElement('button');
      clearBtn.className = 'btn btn-clear-all';
      clearBtn.textContent = 'Clear All';
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearAllErrors(activeServiceId);
      });
      clearBar.appendChild(clearBtn);
      errorList.appendChild(clearBar);
    }

    errors.forEach((err) => {
      const item = document.createElement('div');
      item.className = 'error-item';

      const analysis = analysisMap.get(err.id);
      const analysisBadge = analysis
        ? `<div class="error-analysis-badge"><span class="badge badge-${analysis.analysisType}">${analysis.analysisType === 'ai' ? 'AI' : 'LOCAL'}</span></div>`
        : '';

      item.innerHTML = `
        <div class="error-item-header">
          <span class="error-time">${err.timestamp}</span>
          <button class="btn-delete-error" title="Delete">&times;</button>
        </div>
        <div class="error-message">${escapeHtml(err.message)}</div>
        ${analysisBadge}
      `;

      // Delete button
      const deleteBtn = item.querySelector('.btn-delete-error');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteError(activeServiceId, err.id);
      });

      item.addEventListener('click', () => {
        if (analysisPanel) analysisPanel.dataset.errorId = err.id;
        showAnalysis(err.id, err);
      });
      errorList.appendChild(item);
    });
  }

  function storeAnalysis(result) {
    analysisMap.set(result.errorId, result);

    // Re-render errors if this is the active service
    if (result.serviceId === activeServiceId) {
      renderErrors();

      // If the analysis panel is showing this error, refresh it
      if (analysisPanel && analysisPanel.dataset.errorId === result.errorId) {
        const errors = errorsMap.get(activeServiceId) || [];
        const err = errors.find((e) => e.id === result.errorId);
        if (err) {
          showAnalysis(result.errorId, err);
        }
      }
    }
  }

  function requestAiAnalysis(error) {
    vscode.postMessage({
      type: 'requestAiAnalysis',
      serviceId: error.serviceId || activeServiceId,
      error,
    });
  }

  function buildAiButton(error) {
    return `<button class="btn btn-ai-analyze">AI 분석 요청</button>`;
  }

  function attachAiButton(container, error) {
    const btn = container.querySelector('.btn-ai-analyze');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        btn.disabled = true;
        btn.textContent = 'AI 분석 중...';
        requestAiAnalysis(error);
      });
    }
  }

  function showAnalysis(errorId, error) {
    const analysis = analysisMap.get(errorId);
    if (!analysisPanel || !analysisContent) return;

    analysisPanel.style.display = 'flex';

    if (!analysis) {
      // No analysis yet — AI button on top
      analysisContent.innerHTML = `
        <div class="analysis-section analysis-actions">
          <p style="opacity: 0.6;">로컬 패턴에 매칭되지 않는 에러입니다.</p>
          ${buildAiButton(error)}
        </div>
        <div class="analysis-section">
          <h3>Error Message</h3>
          <pre>${escapeHtml(error.message)}</pre>
        </div>
        <div class="analysis-section">
          <h3>Stack Trace</h3>
          <pre>${escapeHtml(error.stackTrace?.join('\n') || 'No stack trace')}</pre>
        </div>
      `;
      attachAiButton(analysisContent, error);
      return;
    }

    const confidenceClass =
      analysis.confidence >= 0.8 ? 'confidence-high' :
      analysis.confidence >= 0.5 ? 'confidence-medium' : 'confidence-low';

    // Show AI button if only local analysis exists (so user can request deeper AI analysis)
    const showAiBtn = analysis.analysisType === 'local';

    analysisContent.innerHTML = `
      <div class="analysis-section">
        <span class="badge badge-${analysis.analysisType}">
          ${analysis.analysisType === 'ai' ? 'AI Analysis' : 'Local Analysis'}
        </span>
        ${showAiBtn ? buildAiButton(error) : ''}
      </div>
      <div class="analysis-section">
        <h3>${escapeHtml(analysis.title)}</h3>
        <p>${escapeHtml(analysis.description)}</p>
      </div>
      <div class="analysis-section">
        <h3>Solution</h3>
        <pre>${escapeHtml(analysis.suggestion)}</pre>
      </div>
      <div class="analysis-section">
        <h3>Confidence: ${Math.round(analysis.confidence * 100)}%</h3>
        <div class="confidence-bar">
          <div class="confidence-fill ${confidenceClass}" style="width: ${analysis.confidence * 100}%"></div>
        </div>
      </div>
      <div class="analysis-section">
        <h3>Error Details</h3>
        <pre>${escapeHtml(analysis.errorBlock?.message || error.message)}\n\n${escapeHtml(
          (analysis.errorBlock?.stackTrace || error.stackTrace || []).join('\n')
        )}</pre>
      </div>
    `;
    if (showAiBtn) {
      attachAiButton(analysisContent, error);
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Notify extension that webview is ready
  vscode.postMessage({ type: 'webviewReady' });
})();
