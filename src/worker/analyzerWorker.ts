import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { LogParser } from '../analyzer/LogParser';
import { LocalAnalyzer } from '../analyzer/LocalAnalyzer';
import { ClaudeAnalyzer } from '../analyzer/ClaudeAnalyzer';
import {
  ParentToChildMessage,
  ChildToParentMessage,
  ErrorBlock,
  LogLine,
} from '../types';

let springProcess: ChildProcess | null = null;
let logParser: LogParser | null = null;
const localAnalyzer = new LocalAnalyzer();
const claudeAnalyzer = new ClaudeAnalyzer();

let serviceId = '';
let serviceName = '';
let stoppingByUser = false; // true when stop is initiated by user

function send(msg: ChildToParentMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

/**
 * Find the build tool executable.
 * Search order: wrapper in parentPath → wrapper in modulePath → system command
 */
function findExecutable(
  modulePath: string,
  parentPath: string | undefined,
  buildTool: 'gradle' | 'maven'
): { cmd: string; cwd: string } {
  const isWindows = process.platform === 'win32';
  const searchDirs = parentPath ? [parentPath, modulePath] : [modulePath];

  if (buildTool === 'gradle') {
    for (const dir of searchDirs) {
      const wrapper = path.join(dir, isWindows ? 'gradlew.bat' : 'gradlew');
      if (fs.existsSync(wrapper)) {
        return { cmd: wrapper, cwd: dir };
      }
    }
    return { cmd: 'gradle', cwd: parentPath || modulePath };
  } else {
    for (const dir of searchDirs) {
      const wrapper = path.join(dir, isWindows ? 'mvnw.cmd' : 'mvnw');
      if (fs.existsSync(wrapper)) {
        return { cmd: wrapper, cwd: dir };
      }
    }
    return { cmd: 'mvn', cwd: parentPath || modulePath };
  }
}

function resolveCommand(
  modulePath: string,
  command: string,
  parentPath?: string,
  moduleName?: string
): { cmd: string; args: string[]; cwd: string } {
  if (command === 'auto-gradle') {
    const { cmd, cwd } = findExecutable(modulePath, parentPath, 'gradle');
    const args = moduleName ? [`:${moduleName}:bootRun`] : ['bootRun'];
    return { cmd, args, cwd };
  }

  if (command === 'auto-maven') {
    const { cmd, cwd } = findExecutable(modulePath, parentPath, 'maven');
    const args = moduleName
      ? ['-pl', moduleName, 'spring-boot:run']
      : ['spring-boot:run'];
    return { cmd, args, cwd };
  }

  // Custom command
  const parts = command.split(/\s+/);
  return {
    cmd: parts[0],
    args: parts.slice(1),
    cwd: modulePath,
  };
}

/**
 * For multi-module Maven: install dependencies first, then run the target module.
 * This avoids the issue where `-am spring-boot:run` tries to run the parent pom.
 */
function installDependenciesThenRun(
  cmd: string,
  cwd: string,
  moduleName: string,
  processEnv: Record<string, string>,
  onDone: () => void
): void {
  send({ type: 'spring-log', line: `[spring-advisor] Installing dependencies for ${moduleName}...`, level: 'INFO' });

  const installArgs = ['-pl', moduleName, '-am', 'install', '-DskipTests', '-q'];
  const installProcess = spawn(cmd, installArgs, {
    cwd,
    env: processEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  if (installProcess.stdout) {
    const rl = readline.createInterface({ input: installProcess.stdout });
    rl.on('line', (line) => {
      send({ type: 'spring-log', line, level: 'INFO' });
    });
  }
  if (installProcess.stderr) {
    const rl = readline.createInterface({ input: installProcess.stderr });
    rl.on('line', (line) => {
      send({ type: 'spring-log', line, level: 'ERROR' });
    });
  }

  installProcess.on('exit', (code) => {
    if (code === 0) {
      send({ type: 'spring-log', line: `[spring-advisor] Dependencies installed. Starting ${moduleName}...`, level: 'INFO' });
      onDone();
    } else {
      send({ type: 'spring-log', line: `[spring-advisor] Dependency install failed (exit code ${code}). Trying to run anyway...`, level: 'WARN' });
      onDone();
    }
  });
}

function startSpringBoot(
  modulePath: string,
  command: string,
  env?: Record<string, string>,
  parentPath?: string,
  moduleName?: string
): void {
  const { cmd, args, cwd } = resolveCommand(modulePath, command, parentPath, moduleName);
  send({ type: 'status-change', status: 'starting', message: `Starting: ${cmd} ${args.join(' ')} (cwd: ${cwd})` });

  const processEnv = { ...process.env, ...env } as Record<string, string>;

  // For multi-module Maven: install deps first, then run
  if (moduleName && command === 'auto-maven') {
    installDependenciesThenRun(cmd, cwd, moduleName, processEnv, () => {
      launchSpringProcess(cmd, args, cwd, processEnv);
    });
  } else {
    launchSpringProcess(cmd, args, cwd, processEnv);
  }
}

function launchSpringProcess(
  cmd: string,
  args: string[],
  cwd: string,
  processEnv: Record<string, string>
): void {
  logParser = new LogParser(serviceId);

  // LogParser emits structured log events — but we also send raw lines directly below
  logParser.on('error', (errorBlock: ErrorBlock) => {
    send({ type: 'error-detected', error: errorBlock });

    // Auto-run local analysis only (free, instant)
    if (localAnalyzer.canHandle(errorBlock)) {
      const result = localAnalyzer.analyze(errorBlock);
      if (result) {
        send({ type: 'analysis-result', result });
      }
    }
    // AI analysis is NOT auto-triggered — user must request it explicitly
  });

  try {
    springProcess = spawn(cmd, args, {
      cwd,
      env: processEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: 'status-change', status: 'error', message: `Failed to start: ${message}` });
    return;
  }

  // Process stdout — send every line to UI + feed to LogParser for error detection
  if (springProcess.stdout) {
    const rl = readline.createInterface({ input: springProcess.stdout });
    rl.on('line', (line) => {
      // Always forward to UI so logs are visible
      send({ type: 'spring-log', line, level: 'INFO' });
      // Feed to parser for error detection
      logParser?.parseLine(line);
      // Detect successful startup
      if (/Started \w+ in \d+[\.,]\d+ seconds/.test(line)) {
        send({ type: 'status-change', status: 'running', message: 'Spring Boot started successfully' });
      }
    });
  }

  // Process stderr — send every line to UI + feed to LogParser
  if (springProcess.stderr) {
    const rl = readline.createInterface({ input: springProcess.stderr });
    rl.on('line', (line) => {
      send({ type: 'spring-log', line, level: 'ERROR' });
      logParser?.parseLine(line);
    });
  }

  springProcess.on('error', (err) => {
    send({
      type: 'status-change',
      status: 'error',
      message: `Process error: ${err.message}`,
    });
  });

  springProcess.on('exit', (code, signal) => {
    logParser?.flush();
    springProcess = null;

    if (stoppingByUser || code === 0 || signal === 'SIGTERM') {
      stoppingByUser = false;
      send({ type: 'status-change', status: 'stopped', message: 'Process exited normally' });
    } else {
      send({
        type: 'status-change',
        status: 'error',
        message: `Process exited with code ${code}`,
      });
    }
  });
}

function stopSpringBoot(): void {
  if (!springProcess) {
    send({ type: 'status-change', status: 'stopped', message: 'No process running' });
    return;
  }

  stoppingByUser = true;
  logParser?.flush();

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(springProcess.pid), '/f', '/t'], {
      stdio: 'ignore',
    });
  } else {
    springProcess.kill('SIGTERM');
    const forceKillTimer = setTimeout(() => {
      if (springProcess) {
        springProcess.kill('SIGKILL');
      }
    }, 5000);
    springProcess.on('exit', () => clearTimeout(forceKillTimer));
  }
}

// Listen for messages from parent process
process.on('message', (msg: ParentToChildMessage) => {
  switch (msg.type) {
    case 'start':
      serviceId = msg.serviceId;
      serviceName = msg.serviceName;
      startSpringBoot(msg.modulePath, msg.command, msg.env, msg.parentPath, msg.moduleName);
      break;

    case 'stop':
      stopSpringBoot();
      break;

    case 'configure':
      claudeAnalyzer.configure(msg.apiKey, msg.model, msg.maxRequestsPerMinute);
      break;

    case 'analyze-error':
      (async () => {
        const errorBlock = msg.error;
        if (claudeAnalyzer.isConfigured()) {
          const result = await claudeAnalyzer.analyze(errorBlock);
          if (result) {
            send({ type: 'analysis-result', result });
            return;
          }
        }
        send({
          type: 'analysis-result',
          result: {
            errorId: errorBlock.id,
            serviceId: errorBlock.serviceId,
            analysisType: 'ai',
            title: 'AI 분석 불가',
            description: 'Claude API 키가 설정되지 않았습니다.',
            suggestion: '설정(springErrorAnalyzer.claudeApiKey)에서 API 키를 입력해주세요.',
            confidence: 0,
            timestamp: new Date().toISOString(),
            errorBlock,
          },
        });
      })();
      break;
  }
});

process.on('exit', () => {
  if (springProcess) {
    springProcess.kill();
  }
});

process.on('SIGTERM', () => {
  stopSpringBoot();
  process.exit(0);
});
