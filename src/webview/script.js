// @ts-check

(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  /** @type {Array<{id: string, name: string, modulePath: string, status: string, command: string, buildTool: string}>} */
  let services = [];
  let activeServiceId = '';

  /** @type {Map<string, Array<{line: string, level: string}>>} */
  const logsMap = new Map();

  /**
   * 에러 그룹: 동일 (message + logger) 키로 묶음
   * @type {Map<string, Array<{key: string, message: string, logger: string, level: string, count: number, lastTimestamp: string, representativeError: any}>>}
   */
  const errorGroupsMap = new Map();

  /** @type {Map<string, any>} */
  const analysisMap = new Map();

  const MAX_LOG_LINES = 500;

  // ── 로그 필터 상태 ─────────────────────────────────────────
  /** @type {Set<string>} */
  const activeLevels = new Set(['ERROR', 'WARN', 'INFO', 'DEBUG']);
  let logSearchQuery = '';

  // DOM elements
  const serviceTabs      = document.getElementById('service-tabs');
  const noServices       = document.getElementById('no-services');
  const serviceContent   = document.getElementById('service-content');
  const serviceName      = document.getElementById('service-name');
  const serviceStatus    = document.getElementById('service-status');
  const btnStart         = document.getElementById('btn-start');
  const btnStop          = document.getElementById('btn-stop');
  const logContainer     = document.getElementById('log-container');
  const errorCount       = document.getElementById('error-count');
  const errorList        = document.getElementById('error-list');
  const analysisPanel    = document.getElementById('analysis-panel');
  const analysisContent  = document.getElementById('analysis-content');
  const btnCloseAnalysis = document.getElementById('btn-close-analysis');
  const btnClearLogs     = document.getElementById('btn-clear-logs');
  const logSearchInput   = document.getElementById('log-search');
  const logMatchCount    = document.getElementById('log-match-count');

  // 모달 관련 DOM
  const addServiceModal      = document.getElementById('add-service-modal');
  const modalClose           = document.getElementById('modal-close');
  const modalCancel          = document.getElementById('modal-cancel');
  const modalConfirm         = document.getElementById('modal-confirm');
  const modalLoading         = document.getElementById('modal-loading');
  const modalEmpty           = document.getElementById('modal-empty');
  const modalModuleList      = document.getElementById('modal-module-list');
  const moduleListContainer  = document.getElementById('module-list-container');
  const modalSelectedCount   = document.getElementById('modal-selected-count');
  const modalFooter          = document.getElementById('modal-footer');

  /** @type {Set<string>} 현재 모달에서 선택된 modulePath 목록 */
  const selectedModulePaths = new Set();

  // ── 이벤트 리스너 ───────────────────────────────────────────

  btnClearLogs?.addEventListener('click', () => {
    if (activeServiceId) {
      logsMap.set(activeServiceId, []);
      if (logContainer) logContainer.innerHTML = '';
      updateMatchCount();
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
    if (analysisPanel) analysisPanel.classList.add('hidden');
  });

  // ── 서비스 추가 모달 ─────────────────────────────────────────

  function openAddServiceModal() {
    if (!addServiceModal) return;
    selectedModulePaths.clear();
    updateModalConfirmButton();

    // 모든 상태 완전 초기화 (이전 탐색 결과 잔재 제거)
    if (modalLoading) {
      modalLoading.classList.remove('hidden');
    }
    if (modalEmpty) {
      modalEmpty.classList.add('hidden');
      // 이전 탐색 로그 제거
      const oldLog = modalEmpty.querySelector('.detect-log');
      if (oldLog) oldLog.remove();
    }
    if (modalModuleList) {
      modalModuleList.classList.add('hidden');
    }
    if (moduleListContainer) {
      moduleListContainer.innerHTML = '';
    }
    if (modalFooter) {
      modalFooter.classList.add('hidden');
    }

    addServiceModal.classList.remove('hidden');
    // extension에 모듈 탐지 요청
    vscode.postMessage({ type: 'requestDetectModules' });
  }

  function closeAddServiceModal() {
    if (addServiceModal) addServiceModal.classList.add('hidden');
  }

  function updateModalConfirmButton() {
    if (!modalConfirm || !modalSelectedCount) return;
    const count = selectedModulePaths.size;
    /** @type {HTMLButtonElement} */ (modalConfirm).disabled = count === 0;
    modalSelectedCount.textContent = `${count}개 선택됨`;
  }

  // 헤더 "＋ 서비스 추가" 버튼
  document.getElementById('btn-add-service')?.addEventListener('click', openAddServiceModal);
  // 빈 화면 "＋ 서비스 추가" 버튼
  document.getElementById('btn-add-service-empty')?.addEventListener('click', openAddServiceModal);

  // 모달 닫기 버튼들
  modalClose?.addEventListener('click', closeAddServiceModal);
  modalCancel?.addEventListener('click', closeAddServiceModal);
  // 오버레이 바깥 클릭 시 닫기
  addServiceModal?.addEventListener('click', (e) => {
    if (e.target === addServiceModal) closeAddServiceModal();
  });

  // 확인 버튼 → 선택한 모듈 추가 & 시작 요청
  modalConfirm?.addEventListener('click', () => {
    if (selectedModulePaths.size === 0) return;
    vscode.postMessage({
      type: 'addAndStartModules',
      modulePaths: Array.from(selectedModulePaths),
    });
    closeAddServiceModal();
  });

  // 레벨 필터 버튼
  document.querySelectorAll('.btn-level').forEach((btn) => {
    btn.addEventListener('click', () => {
      const level = /** @type {HTMLElement} */ (btn).dataset.level;
      if (!level) return;
      if (activeLevels.has(level)) {
        activeLevels.delete(level);
        btn.classList.remove('active');
      } else {
        activeLevels.add(level);
        btn.classList.add('active');
      }
      applyLogFilter();
    });
  });

  // 키워드 검색
  logSearchInput?.addEventListener('input', () => {
    logSearchQuery = /** @type {HTMLInputElement} */ (logSearchInput).value.trim();
    applyLogFilter();
  });

  // ── 메시지 핸들러 ──────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'serviceListUpdate':
        // service-added / service-removed 이벤트용: 빈 배열이 오더라도
        // snapshotLoad와 달리 로그/에러 상태는 유지하고 탭만 갱신
        services = msg.services;
        renderTabs();
        if (services.length > 0) {
          if (!activeServiceId || !services.find((s) => s.id === activeServiceId)) {
            selectService(services[0].id);
          } else {
            updateServiceView();
          }
        } else {
          activeServiceId = '';
          updateServiceView();
        }
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

      case 'portKillResult':
        handlePortKillResult(msg);
        break;

      case 'detectModulesResult':
        renderModalModules(msg.modules, msg.workspaceInfo);
        break;
    }
  });

  // ── 서비스 탭 렌더링 ────────────────────────────────────────

  function renderTabs() {
    if (!serviceTabs) return;
    serviceTabs.innerHTML = '';

    if (services.length === 0) {
      if (noServices) noServices.classList.remove('hidden');
      if (serviceContent) serviceContent.classList.add('hidden');
      return;
    }

    if (noServices) noServices.classList.add('hidden');
    if (serviceContent) serviceContent.classList.remove('hidden');

    services.forEach((svc) => {
      const tab = document.createElement('div');
      tab.className = `service-tab ${svc.id === activeServiceId ? 'active' : ''}`;

      // 에러 총 발생 횟수 (그룹별 count 합산)
      const groups = errorGroupsMap.get(svc.id) || [];
      const totalErrors = groups.reduce((sum, g) => sum + g.count, 0);
      const errorBadge = totalErrors > 0
        ? `<span class="error-count-badge">${totalErrors > 99 ? '99+' : totalErrors}</span>`
        : '';

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.innerHTML = `<span class="tab-status ${svc.status}"></span>${escapeHtml(svc.name)}${errorBadge}`;
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

  // ── 스냅샷 복원 ─────────────────────────────────────────────

  function loadSnapshot(snapshots, activeId) {
    logsMap.clear();
    errorGroupsMap.clear();
    analysisMap.clear();

    services = snapshots.map((s) => s.service);
    activeServiceId = activeId || (services.length > 0 ? services[0].id : '');

    snapshots.forEach((snap) => {
      logsMap.set(snap.service.id, snap.logs || []);

      // 에러 → 그룹화 복원
      const groups = [];
      (snap.errors || []).forEach((err) => mergeErrorIntoGroups(groups, err));
      errorGroupsMap.set(snap.service.id, groups);

      (snap.analyses || []).forEach((a) => analysisMap.set(a.errorId, a));
    });

    renderTabs();
    updateServiceView();
  }

  // ── 서비스 선택/제거 ────────────────────────────────────────

  function selectService(id) {
    activeServiceId = id;
    renderTabs();
    updateServiceView();
  }

  function removeService(id) {
    logsMap.delete(id);
    errorGroupsMap.delete(id);

    if (activeServiceId === id) {
      const remaining = services.filter((s) => s.id !== id);
      activeServiceId = remaining.length > 0 ? remaining[0].id : '';
    }

    vscode.postMessage({ type: 'removeService', serviceId: id });
  }

  // ── 서비스 뷰 업데이트 ──────────────────────────────────────

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
    if (btnStart) /** @type {HTMLButtonElement} */ (btnStart).disabled = status === 'starting' || status === 'running';
    if (btnStop)  /** @type {HTMLButtonElement} */ (btnStop).disabled  = status === 'idle'     || status === 'stopped';
  }

  // ── 로그 처리 ───────────────────────────────────────────────

  function appendLog(serviceId, line, level) {
    if (!logsMap.has(serviceId)) logsMap.set(serviceId, []);
    const logs = logsMap.get(serviceId);
    logs.push({ line, level });
    if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);

    if (serviceId === activeServiceId && logContainer) {
      const el = createLogLineElement(line, level);
      logContainer.appendChild(el);
      while (logContainer.children.length > MAX_LOG_LINES) {
        logContainer.removeChild(logContainer.firstChild);
      }
      applyFilterToElement(el);

      // 맨 아래 근처일 때만 자동 스크롤
      const threshold = 60;
      const atBottom = logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < threshold;
      if (atBottom) logContainer.scrollTop = logContainer.scrollHeight;
      updateMatchCount();
    }
  }

  /** DOM 로그 줄 요소 생성 */
  function createLogLineElement(line, level) {
    const div = document.createElement('div');
    div.className = `log-line ${level || 'INFO'}`;
    div.dataset.level = level || 'INFO';
    if (logSearchQuery) {
      div.innerHTML = highlightText(escapeHtml(line), logSearchQuery);
    } else {
      div.textContent = line;
    }
    return div;
  }

  function renderLogs() {
    if (!logContainer) return;
    logContainer.innerHTML = '';
    const logs = logsMap.get(activeServiceId) || [];
    const fragment = document.createDocumentFragment();
    logs.forEach((l) => fragment.appendChild(createLogLineElement(l.line, l.level)));
    logContainer.appendChild(fragment);
    applyLogFilter();
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  // ── 로그 필터 ───────────────────────────────────────────────

  function applyLogFilter() {
    if (!logContainer) return;
    const children = logContainer.children;
    let visibleCount = 0;
    for (let i = 0; i < children.length; i++) {
      const el = /** @type {HTMLElement} */ (children[i]);
      applyFilterToElement(el);
      if (!el.classList.contains('hidden')) visibleCount++;
    }
    updateMatchCount(visibleCount, children.length);
  }

  function applyFilterToElement(el) {
    const level   = el.dataset.level || 'INFO';
    const rawText = el.textContent || '';
    const levelOk  = activeLevels.has(level);
    const searchOk = !logSearchQuery || rawText.toLowerCase().includes(logSearchQuery.toLowerCase());

    if (levelOk && searchOk) {
      el.classList.remove('hidden');
      if (logSearchQuery) {
        el.innerHTML = highlightText(escapeHtml(rawText), logSearchQuery);
      } else if (el.querySelector('mark')) {
        // 검색어 해제 시 mark 태그 제거
        el.textContent = rawText;
      }
    } else {
      el.classList.add('hidden');
    }
  }

  function updateMatchCount(visible, total) {
    if (!logMatchCount) return;
    const isFiltered = logSearchQuery || activeLevels.size < 4;
    if (!isFiltered) {
      logMatchCount.textContent = '';
      return;
    }
    if (visible === undefined || total === undefined) {
      if (!logContainer) return;
      const els = logContainer.children;
      let v = 0;
      for (let i = 0; i < els.length; i++) {
        if (!els[i].classList.contains('hidden')) v++;
      }
      logMatchCount.textContent = `${v} / ${els.length}`;
    } else {
      logMatchCount.textContent = `${visible} / ${total}`;
    }
  }

  /** 검색어를 &lt;mark&gt;로 강조한 HTML 반환 */
  function highlightText(escapedHtml, query) {
    if (!query) return escapedHtml;
    const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escapedHtml.replace(
      new RegExp(safeQuery, 'gi'),
      (m) => `<mark class="log-highlight">${m}</mark>`
    );
  }

  // ── 에러 처리 (중복 그룹화) ─────────────────────────────────

  /** 그룹 키: logger + 메시지 앞 120자 */
  function errorGroupKey(err) {
    const msgKey = (err.message || '').substring(0, 120).trim();
    return `${err.logger}||${msgKey}`;
  }

  /** groups 배열에 에러를 머지 */
  function mergeErrorIntoGroups(groups, err) {
    const key = errorGroupKey(err);
    const existing = groups.find((g) => g.key === key);
    if (existing) {
      existing.count++;
      existing.lastTimestamp = err.timestamp;
    } else {
      groups.push({
        key,
        message: err.message,
        logger: err.logger,
        level: err.level,
        count: 1,
        lastTimestamp: err.timestamp,
        representativeError: err,
      });
    }
  }

  function appendError(serviceId, error) {
    if (!errorGroupsMap.has(serviceId)) errorGroupsMap.set(serviceId, []);
    mergeErrorIntoGroups(errorGroupsMap.get(serviceId), error);

    if (serviceId === activeServiceId) {
      renderErrors();
      renderTabs();
    }
  }

  function deleteErrorGroup(serviceId, key) {
    const groups = errorGroupsMap.get(serviceId);
    if (groups) {
      const idx = groups.findIndex((g) => g.key === key);
      if (idx !== -1) {
        const removed = groups.splice(idx, 1)[0];
        if (removed.representativeError) analysisMap.delete(removed.representativeError.id);
      }
    }
    if (analysisPanel && analysisPanel.dataset.groupKey === key) {
      analysisPanel.classList.add('hidden');
    }
    renderErrors();
    renderTabs();
  }

  function clearAllErrors(serviceId) {
    const groups = errorGroupsMap.get(serviceId) || [];
    groups.forEach((g) => {
      if (g.representativeError) analysisMap.delete(g.representativeError.id);
    });
    errorGroupsMap.set(serviceId, []);
    if (analysisPanel) analysisPanel.classList.add('hidden');
    renderErrors();
    renderTabs();
  }

  function renderErrors() {
    if (!errorList || !errorCount) return;
    const groups = errorGroupsMap.get(activeServiceId) || [];
    const totalCount = groups.reduce((sum, g) => sum + g.count, 0);
    errorCount.textContent = String(totalCount);
    errorList.innerHTML = '';

    if (groups.length > 0) {
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

    groups.forEach((group) => {
      const err = group.representativeError;
      const item = document.createElement('div');
      const isWarn = group.level === 'WARN';
      item.className = `error-item${isWarn ? ' warn-item' : ''}`;

      const analysis = analysisMap.get(err.id);
      const analysisBadge = analysis
        ? `<span class="badge badge-${analysis.analysisType}">${analysis.analysisType === 'ai' ? 'AI' : 'LOCAL'}</span>`
        : '';

      const countBadge = group.count > 1
        ? `<span class="error-count-badge">${group.count > 99 ? '99+' : group.count}×</span>`
        : '';

      item.innerHTML = `
        <div class="error-item-header">
          <span class="error-time">${escapeHtml(group.lastTimestamp)}</span>
          <button class="btn-delete-error" title="Delete">&times;</button>
        </div>
        <div class="error-item-title-row">
          <span class="error-message">${escapeHtml(group.message)}</span>
          ${countBadge}
        </div>
        ${analysisBadge ? `<div class="error-analysis-badge">${analysisBadge}</div>` : ''}
      `;

      const deleteBtn = item.querySelector('.btn-delete-error');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteErrorGroup(activeServiceId, group.key);
      });

      item.addEventListener('click', () => {
        if (analysisPanel) {
          analysisPanel.dataset.groupKey = group.key;
          analysisPanel.dataset.errorId  = err.id;
        }
        showAnalysis(err.id, err);
      });

      errorList.appendChild(item);
    });
  }

  // ── 분석 처리 ───────────────────────────────────────────────

  function storeAnalysis(result) {
    analysisMap.set(result.errorId, result);

    if (result.serviceId === activeServiceId) {
      renderErrors();
      if (analysisPanel && analysisPanel.dataset.errorId === result.errorId) {
        const groups = errorGroupsMap.get(activeServiceId) || [];
        const group = groups.find((g) => g.representativeError && g.representativeError.id === result.errorId);
        if (group) showAnalysis(result.errorId, group.representativeError);
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

  function buildAiButton() {
    return `<button class="btn btn-ai-analyze">AI 분석 요청</button>`;
  }

  function attachAiButton(container, error) {
    const btn = container.querySelector('.btn-ai-analyze');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        /** @type {HTMLButtonElement} */ (btn).disabled = true;
        btn.textContent = 'AI 분석 중...';
        requestAiAnalysis(error);
      });
    }
  }

  // ── 포트 Kill ───────────────────────────────────────────────

  /**
   * 에러 메시지 또는 스택트레이스에서 포트 번호 추출
   * @param {any} error
   * @returns {number|null}
   */
  function extractPort(error) {
    const fullText = [
      error.message || '',
      ...(error.stackTrace || []),
    ].join('\n');

    // "Address already in use: 0.0.0.0:8080" 또는 "port 8080" 형태
    const patterns = [
      /:(\d{4,5})\b/,                   // :8080
      /port[:\s]+(\d{4,5})\b/i,         // port 8080 / port: 8080
      /PortInUseException.*?(\d{4,5})/i,
    ];
    for (const re of patterns) {
      const m = fullText.match(re);
      if (m) {
        const p = parseInt(m[1], 10);
        if (p >= 1024 && p <= 65535) return p;
      }
    }
    return null;
  }

  /** 포트 Kill 버튼 HTML */
  function buildKillPortButton(port) {
    return `<button class="btn btn-kill-port" data-port="${port}">포트 ${port} 프로세스 종료</button>`;
  }

  /** 포트 Kill 버튼 이벤트 바인딩 */
  function attachKillPortButton(container, port, serviceId) {
    const btn = container.querySelector('.btn-kill-port');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        /** @type {HTMLButtonElement} */ (btn).disabled = true;
        btn.textContent = '종료 중...';
        vscode.postMessage({ type: 'killPort', port, serviceId });
      });
    }
  }

  /** portKillResult 메시지 수신 처리 */
  function handlePortKillResult(msg) {
    const resultEl = analysisContent && analysisContent.querySelector('.port-kill-result');
    if (resultEl) {
      resultEl.className = `port-kill-result ${msg.success ? 'kill-success' : 'kill-fail'}`;
      resultEl.textContent = msg.message;
    }
    // Kill 버튼 텍스트 복원
    const killBtn = analysisContent && analysisContent.querySelector('.btn-kill-port');
    if (killBtn) {
      /** @type {HTMLButtonElement} */ (killBtn).disabled = msg.success;
      if (!msg.success) killBtn.textContent = `포트 ${msg.port} 프로세스 종료`;
    }
  }

  function showAnalysis(errorId, error) {
    const analysis = analysisMap.get(errorId);
    if (!analysisPanel || !analysisContent) return;

    analysisPanel.classList.remove('hidden');
    analysisPanel.dataset.errorId = errorId;

    // 포트 충돌 감지
    const isPortConflict = /Address already in use|PortInUseException|BindException/i.test(
      [error.message, ...(error.stackTrace || [])].join('\n')
    );
    const port = isPortConflict ? extractPort(error) : null;
    const portKillHtml = port
      ? `${buildKillPortButton(port)}<div class="port-kill-result"></div>`
      : '';

    if (!analysis) {
      analysisContent.innerHTML = `
        <div class="analysis-section analysis-actions">
          <p style="opacity: 0.6;">로컬 패턴에 매칭되지 않는 에러입니다.</p>
          ${buildAiButton()}
          ${portKillHtml}
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
      if (port) attachKillPortButton(analysisContent, port, error.serviceId || activeServiceId);
      return;
    }

    const confidenceClass =
      analysis.confidence >= 0.8 ? 'confidence-high' :
      analysis.confidence >= 0.5 ? 'confidence-medium' : 'confidence-low';

    const showAiBtn = analysis.analysisType === 'local';

    analysisContent.innerHTML = `
      <div class="analysis-section">
        <span class="badge badge-${analysis.analysisType}">
          ${analysis.analysisType === 'ai' ? 'AI Analysis' : 'Local Analysis'}
        </span>
        ${showAiBtn ? buildAiButton() : ''}
        ${portKillHtml}
      </div>
      <div class="analysis-section">
        <h3>${escapeHtml(analysis.title)}</h3>
        <p>${escapeHtml(analysis.description)}</p>
      </div>
      <div class="analysis-section">
        <h3>Solution</h3>
        <div class="suggestion-body">${renderInlineMarkdown(analysis.suggestion)}</div>
      </div>
      ${renderCodeContexts(analysis.codeContexts)}
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
    if (showAiBtn) attachAiButton(analysisContent, error);
    if (port) attachKillPortButton(analysisContent, port, error.serviceId || activeServiceId);
  }

  // ── 서비스 추가 모달 - 모듈 목록 렌더링 ────────────────────────

  /**
   * @param {Array<{name: string, modulePath: string, buildTool: string, isMultiModule: boolean}>} modules
   */
  function renderModalModules(modules, workspaceInfo) {
    if (!modalLoading || !modalEmpty || !modalModuleList || !moduleListContainer || !modalFooter) return;

    modalLoading.classList.add('hidden');

    if (modules.length === 0) {
      modalEmpty.classList.remove('hidden');
      modalModuleList.classList.add('hidden');
      modalFooter.classList.add('hidden');
      // 탐색 로그 표시
      let logEl = modalEmpty.querySelector('.detect-log');
      if (!logEl) {
        logEl = document.createElement('pre');
        logEl.className = 'detect-log';
        modalEmpty.appendChild(logEl);
      }
      logEl.textContent = workspaceInfo || '탐색 정보 없음';
      return;
    }

    modalEmpty.classList.add('hidden');
    modalModuleList.classList.remove('hidden');
    modalFooter.classList.remove('hidden');
    moduleListContainer.innerHTML = '';

    // 이미 추가된 서비스의 modulePath 목록
    const existingPaths = new Set(services.map((s) => s.modulePath));

    modules.forEach((mod) => {
      const alreadyAdded = existingPaths.has(mod.modulePath);
      const item = document.createElement('label');
      item.className = `module-item${alreadyAdded ? ' module-item-added' : ''}`;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'module-checkbox';
      checkbox.value = mod.modulePath;
      checkbox.disabled = alreadyAdded;
      if (alreadyAdded) {
        checkbox.checked = false;
      }

      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedModulePaths.add(mod.modulePath);
        } else {
          selectedModulePaths.delete(mod.modulePath);
        }
        updateModalConfirmButton();
      });

      const info = document.createElement('div');
      info.className = 'module-info';

      const nameLine = document.createElement('div');
      nameLine.className = 'module-name';
      nameLine.textContent = mod.name;

      const metaLine = document.createElement('div');
      metaLine.className = 'module-meta';
      const buildBadge = `<span class="badge-buildtool badge-${mod.buildTool}">${mod.buildTool}</span>`;
      const multiTag = mod.isMultiModule ? `<span class="badge-multi">multi</span>` : '';
      const addedTag = alreadyAdded ? `<span class="badge-added">추가됨</span>` : '';
      metaLine.innerHTML = `${buildBadge}${multiTag}${addedTag} <span class="module-path">${escapeHtml(mod.modulePath)}</span>`;

      info.appendChild(nameLine);
      info.appendChild(metaLine);
      item.appendChild(checkbox);
      item.appendChild(info);
      moduleListContainer.appendChild(item);
    });
  }

  // ── 유틸 ────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Java/Kotlin/Spring 코드처럼 보이는 줄인지 휴리스틱으로 판단한다.
   * Claude가 backtick 없이 코드를 반환할 때 자동 감지에 사용.
   */
  function isCodeLine(line) {
    const t = line.trim();
    if (!t) return false;
    // 들여쓰기된 줄 (공백/탭으로 시작)
    if (/^\s+\S/.test(line)) return true;
    // Java/Kotlin 키워드로 시작
    if (/^(if\s*\(|else[\s{]|for\s*\(|while\s*\(|return[\s;(]|throw\s|try[\s{]|catch\s*\(|finally[\s{]|new\s+[A-Z]|import\s|package\s|public\s|private\s|protected\s|static\s|final\s|void\s|@[A-Za-z])/.test(t)) return true;
    // 중괄호만 있는 줄
    if (/^[{}]+$/.test(t)) return true;
    // 세미콜론으로 끝나는 줄
    if (t.endsWith(';')) return true;
    // 대문자 시작 타입 선언: Authentication auth = ...
    if (/^[A-Z]\w*[\w<>, \[\]]*\s+\w+\s*[=;(]/.test(t)) return true;
    return false;
  }

  /**
   * 텍스트에서 코드 블록을 감지하여 강조 HTML로 변환한다.
   * 우선순위:
   *   1) 명시적 ```...``` 백틱 블록
   *   2) Java/Kotlin 코드 패턴 자동 감지 (Claude가 backtick 없이 반환할 때)
   *   3) `인라인 코드` 백틱
   */
  function renderInlineMarkdown(text) {
    if (!text) return '';

    const lines = text.split('\n');
    const parts = [];
    let codeBuffer = [];
    let textBuffer = [];
    let inTripleBacktick = false;

    function flushText() {
      if (textBuffer.length === 0) return;
      while (textBuffer.length && !textBuffer[0].trim()) textBuffer.shift();
      while (textBuffer.length && !textBuffer[textBuffer.length - 1].trim()) textBuffer.pop();
      if (textBuffer.length === 0) { textBuffer = []; return; }
      const html = textBuffer.map((line) => {
        if (!line.trim()) return '<br>';
        return escapeHtml(line).replace(
          /`([^`\n]+)`/g,
          (_, c) => `<code class="inline-code">${c}</code>`
        );
      }).join('<br>');
      parts.push(`<p class="suggestion-text">${html}</p>`);
      textBuffer = [];
    }

    function flushCode() {
      if (codeBuffer.length === 0) return;
      while (codeBuffer.length && !codeBuffer[0].trim()) codeBuffer.shift();
      while (codeBuffer.length && !codeBuffer[codeBuffer.length - 1].trim()) codeBuffer.pop();
      if (codeBuffer.length === 0) { codeBuffer = []; return; }
      parts.push(`<pre class="suggestion-code-block">${escapeHtml(codeBuffer.join('\n'))}</pre>`);
      codeBuffer = [];
    }

    for (const line of lines) {
      // 명시적 ``` 블록
      if (line.trim().startsWith('```')) {
        if (!inTripleBacktick) {
          flushText();
          inTripleBacktick = true;
        } else {
          inTripleBacktick = false;
          flushCode();
        }
        continue;
      }
      if (inTripleBacktick) {
        codeBuffer.push(line);
        continue;
      }
      // 코드 패턴 자동 감지
      if (isCodeLine(line)) {
        if (textBuffer.length > 0) flushText();
        codeBuffer.push(line);
      } else {
        if (codeBuffer.length > 0) flushCode();
        textBuffer.push(line);
      }
    }

    flushText();
    flushCode();
    return parts.join('');
  }

  /**
   * CodeContextExtractor가 생성한 코드 스니펫을 HTML 테이블로 렌더링한다.
   * '>>>' 마커가 붙은 라인(에러 발생 라인)을 빨간 배경으로 강조한다.
   *
   * @param {string} snippet  '>>>  0042 | code...' 형식의 문자열
   */
  function renderCodeSnippet(snippet) {
    if (!snippet) return '';
    const lines = snippet.split('\n');
    const rows = lines.map((line) => {
      const isError = line.startsWith('>>>');
      // 포맷: ">>>  0042 | actual code" 또는 "    0042 | actual code"
      const match = line.match(/^(>>>|   )\s+(\d+)\s\|\s?(.*)/);
      if (!match) {
        // 파싱 실패 시 그대로 출력
        return `<tr class="${isError ? 'code-error-line' : ''}">
          <td class="code-line-num"></td>
          <td class="code-line-body">${escapeHtml(line)}</td>
        </tr>`;
      }
      const [, , lineNum, code] = match;
      return `<tr class="${isError ? 'code-error-line' : ''}">
        <td class="code-line-num">${escapeHtml(lineNum)}</td>
        <td class="code-line-body">${escapeHtml(code)}</td>
      </tr>`;
    });
    return `<table class="code-snippet-table">${rows.join('')}</table>`;
  }

  /**
   * codeContexts 배열을 HTML 섹션으로 렌더링한다.
   * @param {Array<{className: string, methodName: string, fileName: string, lineNumber: number, codeSnippet: string}>} contexts
   */
  function renderCodeContexts(contexts) {
    if (!contexts || contexts.length === 0) return '';
    const parts = contexts.map((ctx) => {
      const label = `${escapeHtml(ctx.className)}.${escapeHtml(ctx.methodName)}()`;
      const fileRef = `${escapeHtml(ctx.fileName)}:${ctx.lineNumber}`;
      return `
        <div class="code-context-item">
          <div class="code-context-label">
            <span class="code-context-method">${label}</span>
            <span class="code-context-file">${fileRef}</span>
          </div>
          ${renderCodeSnippet(ctx.codeSnippet)}
        </div>
      `;
    });
    return `
      <div class="analysis-section">
        <h3>소스 코드</h3>
        ${parts.join('')}
      </div>
    `;
  }

  // ── 로그 패널 너비 리사이즈 ─────────────────────────────────

  (function () {
    const resizer  = document.getElementById('log-resizer');
    const logPanel = document.getElementById('log-panel');
    const panelsEl = document.getElementById('panels');
    if (!resizer || !logPanel || !panelsEl) { return; }

    let isResizing  = false;
    let startX      = 0;
    let startWidth  = 0;

    resizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX     = e.clientX;
      startWidth = logPanel.getBoundingClientRect().width;
      resizer.classList.add('resizing');
      document.body.style.cursor     = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) { return; }
      const dx        = e.clientX - startX;
      const newWidth  = startWidth + dx;
      const maxWidth  = panelsEl.getBoundingClientRect().width * 0.70;
      const clamped   = Math.max(150, Math.min(newWidth, maxWidth));
      logPanel.style.flex = `0 0 ${clamped}px`;
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) { return; }
      isResizing = false;
      resizer.classList.remove('resizing');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
    });

    // 더블클릭 시 초기 너비로 리셋
    resizer.addEventListener('dblclick', () => {
      logPanel.style.flex = '1 1 0';
    });
  })();

  // webview 준비 완료 알림
  vscode.postMessage({ type: 'webviewReady' });
})();
