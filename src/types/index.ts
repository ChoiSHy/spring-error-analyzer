// ===== Service Types =====

export type ServiceStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export interface ServiceInfo {
  id: string;
  name: string;
  modulePath: string;
  status: ServiceStatus;
  command: string;
  buildTool: 'gradle' | 'maven';
}

// ===== Log & Error Types =====

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';

export interface LogLine {
  timestamp: string;
  level: LogLevel;
  pid: string;
  thread: string;
  logger: string;
  message: string;
  raw: string;
}

export interface ErrorBlock {
  id: string;
  timestamp: string;
  level: LogLevel;
  logger: string;
  thread: string;
  message: string;
  stackTrace: string[];
  rawLines: string[];
  serviceId: string;
}

// ===== Analysis Types =====

export type AnalysisType = 'local' | 'ai';

/** 스택 프레임에서 추출한 소스 코드 컨텍스트 (webview 표시용) */
export interface CodeContext {
  className: string;
  methodName: string;
  fileName: string;
  lineNumber: number;
  codeSnippet: string; // '>>> lineNum | code' 형식의 포맷된 문자열
}

export interface AnalysisResult {
  errorId: string;
  serviceId: string;
  analysisType: AnalysisType;
  title: string;
  description: string;
  suggestion: string;
  confidence: number; // 0.0 ~ 1.0
  timestamp: string;
  errorBlock: ErrorBlock;
  codeContexts?: CodeContext[]; // 에러 위치 소스 코드 (AI 분석 시만 포함)
}

// ===== Webview Messages =====

export interface RequestServiceListMessage {
  type: 'requestServiceList';
}

export interface StartServiceMessage {
  type: 'startService';
  serviceId: string;
}

export interface StopServiceMessage {
  type: 'stopService';
  serviceId: string;
}

export interface GetErrorDetailsMessage {
  type: 'getErrorDetails';
  errorId: string;
}

export interface RemoveServiceMessage {
  type: 'removeService';
  serviceId: string;
}

export interface WebviewReadyMessage {
  type: 'webviewReady';
}

export interface RequestAiAnalysisMessage {
  type: 'requestAiAnalysis';
  serviceId: string;
  error: ErrorBlock;
}

export interface KillPortMessage {
  type: 'killPort';
  port: number;
  serviceId: string;
}

/** Webview → Extension: 워크스페이스 모듈 탐지 요청 */
export interface RequestDetectModulesMessage {
  type: 'requestDetectModules';
}

/** Webview → Extension: 선택된 모듈들을 추가 & 시작 */
export interface AddAndStartModulesMessage {
  type: 'addAndStartModules';
  modulePaths: string[]; // 선택된 모듈들의 modulePath 목록
}

export type WebviewToExtensionMessage =
  | RequestServiceListMessage
  | StartServiceMessage
  | StopServiceMessage
  | GetErrorDetailsMessage
  | WebviewReadyMessage
  | RequestAiAnalysisMessage
  | RemoveServiceMessage
  | KillPortMessage
  | RequestDetectModulesMessage
  | AddAndStartModulesMessage;

// ===== Extension → Webview Messages =====

export interface ServiceListUpdate {
  type: 'serviceListUpdate';
  services: ServiceInfo[];
}

export interface ServiceStatusUpdate {
  type: 'serviceStatusUpdate';
  serviceId: string;
  status: ServiceStatus;
}

export interface LogUpdate {
  type: 'logUpdate';
  serviceId: string;
  line: string;
  level: string;
}

export interface ErrorUpdate {
  type: 'errorUpdate';
  serviceId: string;
  error: ErrorBlock;
}

export interface AnalysisUpdate {
  type: 'analysisUpdate';
  result: AnalysisResult;
}

// 패널이 재생성될 때 extension → webview 전체 상태 일괄 전송
export interface ServiceSnapshot {
  service: ServiceInfo;
  logs: Array<{ line: string; level: string }>;
  errors: ErrorBlock[];
  analyses: AnalysisResult[];
}

export interface SnapshotLoad {
  type: 'snapshotLoad';
  snapshots: ServiceSnapshot[];
  activeServiceId: string;
}

export interface PortKillResult {
  type: 'portKillResult';
  port: number;
  success: boolean;
  message: string;
}

/** 탐지된 모듈 정보 (webview 표시용) */
export interface DetectedModuleInfo {
  name: string;
  modulePath: string;
  buildTool: 'gradle' | 'maven';
  isMultiModule: boolean; // parentPath가 있으면 true
}

/** Extension → Webview: 탐지된 모듈 목록 전송 */
export interface DetectModulesResult {
  type: 'detectModulesResult';
  modules: DetectedModuleInfo[];
  workspaceInfo?: string;
}

export type ExtensionToWebviewMessage =
  | ServiceListUpdate
  | ServiceStatusUpdate
  | LogUpdate
  | ErrorUpdate
  | AnalysisUpdate
  | SnapshotLoad
  | PortKillResult
  | DetectModulesResult;
