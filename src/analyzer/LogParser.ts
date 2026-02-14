import { EventEmitter } from 'events';
import { ErrorBlock, LogLevel, LogLine } from '../types';

// Spring Boot 2.x log format:
// 2024-01-15 10:30:45.123  ERROR 12345 --- [main] c.e.demo.MyApp : Something went wrong
// Spring Boot 3.x log format (with T separator + optional app name bracket):
// 2026-02-15T00:35:53.588+09:00 ERROR 3228 --- [demo-system] [  restartedMain] o.s.boot.SpringApplication  : Application run failed
// The key difference: 3.x has [appname] [thread], 2.x has only [thread]
const LOG_LINE_REGEX =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\.\d{3}[^\s]*)\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+(\d+)\s+---\s+(?:\[[^\]]*\]\s+)?\[([^\]]+)\]\s+([\w.$]+)\s*:\s*(.*)$/;

const STACK_TRACE_LINE_REGEX = /^\s+at\s+/;
const CAUSED_BY_REGEX = /^Caused by:\s+/;
const EXCEPTION_LINE_REGEX = /^[\w.$]+(?:Exception|Error|Throwable)/;

export class LogParser extends EventEmitter {
  private currentError: Partial<ErrorBlock> | null = null;
  private stackTraceBuffer: string[] = [];
  private rawLinesBuffer: string[] = [];
  private contextLinesBuffer: string[] = []; // Non-stack-trace continuation lines (e.g., FailureAnalysisReporter)
  private serviceId: string;
  private errorCounter = 0;

  constructor(serviceId: string) {
    super();
    this.serviceId = serviceId;
  }

  parseLine(raw: string): void {
    const trimmed = raw.trimEnd();

    // Empty lines: keep them if we're collecting an error block
    if (!trimmed) {
      if (this.currentError) {
        this.rawLinesBuffer.push('');
        this.contextLinesBuffer.push('');
      }
      return;
    }

    const logMatch = trimmed.match(LOG_LINE_REGEX);

    if (logMatch) {
      // New structured log line — flush any in-progress error first
      this.flushCurrentError();

      const [, timestamp, level, , thread, logger, message] = logMatch;
      const logLine: LogLine = {
        timestamp,
        level: level as LogLevel,
        pid: logMatch[3],
        thread: thread.trim(),
        logger,
        message,
        raw: trimmed,
      };

      this.emit('log', logLine);

      if (level === 'ERROR') {
        this.currentError = {
          id: `${this.serviceId}-err-${++this.errorCounter}`,
          timestamp,
          level: 'ERROR',
          logger,
          thread: thread.trim(),
          message,
          serviceId: this.serviceId,
        };
        this.stackTraceBuffer = [];
        this.rawLinesBuffer = [trimmed];
        this.contextLinesBuffer = [];
      }
    } else if (this.currentError) {
      // Continuation line belonging to the current error block
      if (
        STACK_TRACE_LINE_REGEX.test(trimmed) ||
        CAUSED_BY_REGEX.test(trimmed) ||
        EXCEPTION_LINE_REGEX.test(trimmed) ||
        trimmed.startsWith('\t') ||
        trimmed.startsWith('    ...')
      ) {
        this.stackTraceBuffer.push(trimmed);
        this.rawLinesBuffer.push(trimmed);
      } else {
        // Non-stack-trace continuation line — keep collecting
        // (handles FailureAnalysisReporter blocks, multi-line error messages, etc.)
        this.contextLinesBuffer.push(trimmed);
        this.rawLinesBuffer.push(trimmed);
      }
    }
  }

  flush(): void {
    this.flushCurrentError();
  }

  private flushCurrentError(): void {
    if (!this.currentError) {
      return;
    }

    // Build the effective message: if the original message is empty/whitespace,
    // extract a meaningful message from context lines (e.g., FailureAnalysisReporter output)
    let message = this.currentError.message || '';

    if (!message.trim() && this.contextLinesBuffer.length > 0) {
      // Extract meaningful content from context lines, skipping decorations
      const meaningful = this.contextLinesBuffer
        .filter(line => {
          const t = line.trim();
          // Skip empty lines, decoration lines (***...), and section headers
          return t && !/^\*+$/.test(t);
        });
      message = meaningful.join(' | ') || 'Error (see details)';
    }

    if (message.trim()) {
      // Also add context lines to stackTrace so LocalAnalyzer can pattern-match them
      const allTraceLines = [...this.stackTraceBuffer, ...this.contextLinesBuffer.filter(l => l.trim())];

      const errorBlock: ErrorBlock = {
        id: this.currentError.id!,
        timestamp: this.currentError.timestamp!,
        level: this.currentError.level!,
        logger: this.currentError.logger!,
        thread: this.currentError.thread!,
        message,
        stackTrace: allTraceLines,
        rawLines: [...this.rawLinesBuffer],
        serviceId: this.serviceId,
      };

      this.emit('error', errorBlock);
    }

    this.currentError = null;
    this.stackTraceBuffer = [];
    this.rawLinesBuffer = [];
    this.contextLinesBuffer = [];
  }
}
