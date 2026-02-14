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
}

// ===== IPC Messages: Parent → Child =====

export interface StartMessage {
  type: 'start';
  modulePath: string;
  parentPath?: string; // For multi-module: parent pom directory
  moduleName?: string; // For multi-module: -pl argument
  command: string;
  env?: Record<string, string>;
  serviceId: string;
  serviceName: string;
}

export interface StopMessage {
  type: 'stop';
}

export interface ConfigureMessage {
  type: 'configure';
  apiKey: string;
  model: string;
  maxRequestsPerMinute: number;
}

export interface AnalyzeErrorMessage {
  type: 'analyze-error';
  error: ErrorBlock;
}

export type ParentToChildMessage = StartMessage | StopMessage | ConfigureMessage | AnalyzeErrorMessage;

// ===== IPC Messages: Child → Parent =====

export interface StatusChangeMessage {
  type: 'status-change';
  status: ServiceStatus;
  message?: string;
}

export interface SpringLogMessage {
  type: 'spring-log';
  line: string;
  level: string;
}

export interface ErrorDetectedMessage {
  type: 'error-detected';
  error: ErrorBlock;
}

export interface AnalysisResultMessage {
  type: 'analysis-result';
  result: AnalysisResult;
}

export type ChildToParentMessage =
  | StatusChangeMessage
  | SpringLogMessage
  | ErrorDetectedMessage
  | AnalysisResultMessage

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

export interface WebviewReadyMessage {
  type: 'webviewReady';
}

export interface RequestAiAnalysisMessage {
  type: 'requestAiAnalysis';
  serviceId: string;
  error: ErrorBlock;
}

export type WebviewToExtensionMessage =
  | RequestServiceListMessage
  | StartServiceMessage
  | StopServiceMessage
  | GetErrorDetailsMessage
  | WebviewReadyMessage
  | RequestAiAnalysisMessage;

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

export type ExtensionToWebviewMessage =
  | ServiceListUpdate
  | ServiceStatusUpdate
  | LogUpdate
  | ErrorUpdate
  | AnalysisUpdate;
