import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { SpringBootService, JdtMode } from './SpringBootService';
import { ServiceInfo, AnalysisResult, ErrorBlock, ServiceSnapshot } from '../types';

export interface DetectedModule {
  name: string;
  modulePath: string;
  buildTool: 'gradle' | 'maven';
  parentPath?: string;  // Multi-module: parent directory with root pom/gradle
  moduleName?: string;  // Multi-module: -pl argument (e.g., "demo-auth")
}

export class ServiceManager extends EventEmitter {
  private services = new Map<string, SpringBootService>();

  constructor() {
    super();
  }

  getServices(): ServiceInfo[] {
    return Array.from(this.services.values()).map((s) => s.getInfo());
  }

  getService(id: string): SpringBootService | undefined {
    return this.services.get(id);
  }

  /** 모든 서비스의 현재 상태 스냅샷 반환 (webview 재생성 시 사용) */
  getSnapshots(): ServiceSnapshot[] {
    return Array.from(this.services.values()).map((s) => ({
      service: s.getInfo(),
      logs: s.logs,
      errors: s.errors,
      analyses: s.analyses,
    }));
  }

  async detectModules(): Promise<DetectedModule[]> {
    const modules: DetectedModule[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return modules;

    for (const folder of workspaceFolders) {
      const rootPath = folder.uri.fsPath;
      await this.scanForModules(rootPath, modules, 0, rootPath);
    }

    return modules;
  }

  /** 디버그용: 탐색 과정 상세 로그 반환 */
  async detectModulesWithLog(): Promise<{ modules: DetectedModule[]; log: string[] }> {
    const modules: DetectedModule[] = [];
    const log: string[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders) {
      log.push('❌ 열린 워크스페이스 없음');
      return { modules, log };
    }

    for (const folder of workspaceFolders) {
      const rootPath = folder.uri.fsPath;
      log.push(`📁 워크스페이스: ${rootPath}`);
      await this.scanForModulesWithLog(rootPath, modules, 0, log);
    }

    if (modules.length === 0) {
      log.push('⚠️ 탐색 완료 - 모듈 없음');
    } else {
      log.push(`✅ 탐색 완료 - ${modules.length}개 발견`);
    }

    return { modules, log };
  }

  private async scanForModulesWithLog(
    dirPath: string,
    modules: DetectedModule[],
    depth: number,
    log: string[]
  ): Promise<void> {
    if (depth > 4) return;

    const indent = '  '.repeat(depth);
    const hasGradle = fs.existsSync(path.join(dirPath, 'build.gradle')) ||
      fs.existsSync(path.join(dirPath, 'build.gradle.kts'));
    const hasMaven = fs.existsSync(path.join(dirPath, 'pom.xml'));
    const hasSrcMain = fs.existsSync(path.join(dirPath, 'src', 'main'));
    const hasSrcMainJava = fs.existsSync(path.join(dirPath, 'src', 'main', 'java')) ||
      fs.existsSync(path.join(dirPath, 'src', 'main', 'kotlin'));

    if (hasGradle || hasMaven) {
      const isMavenParent = hasMaven && (() => {
        try {
          const content = fs.readFileSync(path.join(dirPath, 'pom.xml'), 'utf-8');
          return content.includes('<packaging>pom</packaging>');
        } catch { return false; }
      })();

      const hasSrc = hasSrcMain || hasSrcMainJava;
      const name = path.basename(dirPath);

      if (isMavenParent) {
        log.push(`${indent}⏭️ ${name} - Maven parent pom (제외)`);
      } else if (!hasSrc) {
        log.push(`${indent}⚠️ ${name} - build 파일 있음, src/main 없음 (제외)`);
      } else {
        log.push(`${indent}✅ ${name} - ${hasGradle ? 'gradle' : 'maven'} 모듈 발견`);
        modules.push({
          name,
          modulePath: dirPath,
          buildTool: hasGradle ? 'gradle' : 'maven',
        });
        return; // 모듈 발견 시 하위 탐색 불필요
      }
    }

    // 하위 디렉토리 탐색
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const skipDirs = new Set(['.git', 'node_modules', 'build', 'target', 'out', '.idea', '.gradle']);
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !skipDirs.has(entry.name)) {
          await this.scanForModulesWithLog(path.join(dirPath, entry.name), modules, depth + 1, log);
        }
      }
    } catch {
      log.push(`${indent}❌ 접근 오류: ${dirPath}`);
    }
  }
  private findMavenParent(startDir: string): string | undefined {
    let current = startDir;

    while (true) {
      const parent = path.dirname(current);
      if (parent === current) break;

      const pomPath = path.join(parent, 'pom.xml');
      if (fs.existsSync(pomPath)) {
        const content = fs.readFileSync(pomPath, 'utf-8');
        if (content.includes('<packaging>pom</packaging>')) {
          return parent;
        }
      }

      current = parent;
    }

    return undefined;
  }

  private async scanForModules(
    dirPath: string,
    modules: DetectedModule[],
    depth: number,
    workspaceRoot: string
  ): Promise<void> {
    if (depth > 3) return;

    const hasGradle = fs.existsSync(path.join(dirPath, 'build.gradle')) ||
      fs.existsSync(path.join(dirPath, 'build.gradle.kts'));
    const hasMaven = fs.existsSync(path.join(dirPath, 'pom.xml'));
    const hasSrcMain = fs.existsSync(path.join(dirPath, 'src', 'main'));
    const hasSrcMainJava = fs.existsSync(path.join(dirPath, 'src', 'main', 'java')) ||
      fs.existsSync(path.join(dirPath, 'src', 'main', 'kotlin'));

    // Maven parent pom (packaging=pom)은 실행 대상이 아님 → 제외
    const isMavenParent = hasMaven && (() => {
      try {
        const content = fs.readFileSync(path.join(dirPath, 'pom.xml'), 'utf-8');
        return content.includes('<packaging>pom</packaging>');
      } catch { return false; }
    })();

    // src/main 또는 src/main/java(kotlin) 중 하나라도 있으면 Spring Boot 모듈로 간주
    const isSpringModule = (hasGradle || hasMaven) && (hasSrcMain || hasSrcMainJava) && !isMavenParent;

    if (isSpringModule) {
      const name = path.basename(dirPath);

      let parentPath: string | undefined;
      let moduleName: string | undefined;

      if (hasMaven) {
        const mavenParent = this.findMavenParent(dirPath);
        if (mavenParent) {
          parentPath = mavenParent;
          moduleName = name;
        }
      }

      modules.push({
        name,
        modulePath: dirPath,
        buildTool: hasGradle ? 'gradle' : 'maven',
        parentPath,
        moduleName,
      });
    }

    // Scan subdirectories for multi-module projects
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules' &&
          entry.name !== 'build' &&
          entry.name !== 'target' &&
          entry.name !== 'out'
        ) {
          await this.scanForModules(path.join(dirPath, entry.name), modules, depth + 1, workspaceRoot);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  async addService(module: DetectedModule): Promise<SpringBootService> {
    const id = `service-${module.name}-${Date.now()}`;

    const config = vscode.workspace.getConfiguration('springErrorAnalyzer');
    const buildToolSetting = config.get<string>('buildTool', 'auto');
    const buildTool =
      buildToolSetting === 'auto'
        ? module.buildTool
        : (buildToolSetting as 'gradle' | 'maven');

    const service = new SpringBootService(
      id, module.name, module.modulePath, buildTool,
      module.parentPath, module.moduleName
    );

    // Forward events
    service.on('status-change', (status) => {
      this.emit('status-change', id, status);
    });
    service.on('log', (line: string, level: string) => {
      this.emit('log', id, line, level);
    });
    service.on('error-detected', (error: ErrorBlock) => {
      this.emit('error-detected', id, error);
    });
    service.on('analysis-result', (result: AnalysisResult) => {
      this.emit('analysis-result', id, result);
    });

    this.services.set(id, service);
    this.emit('service-added', id);
    return service;
  }

  startService(id: string): void {
    const service = this.services.get(id);
    if (!service) return;

    const config = vscode.workspace.getConfiguration('springErrorAnalyzer');
    const apiKey = config.get<string>('claudeApiKey', '');
    const model = config.get<string>('claudeModel', 'claude-sonnet-4-5-20250929');
    const maxRequests = config.get<number>('maxAiRequestsPerMinute', 10);
    const profiles = config.get<string>('bootRunProfiles', '');
    const jvmArgs = config.get<string>('jvmArgs', '');
    const useJdt = config.get<JdtMode>('useJdt', 'auto');
    service.start(apiKey, model, maxRequests, profiles || undefined, jvmArgs || undefined, useJdt);
  }

  stopService(id: string): void {
    const service = this.services.get(id);
    if (service) {
      service.stop();
    }
  }

  requestAiAnalysis(serviceId: string, error: ErrorBlock): void {
    const service = this.services.get(serviceId);
    if (service) {
      service.requestAiAnalysis(error);
    }
  }

  stopAll(): void {
    for (const service of this.services.values()) {
      service.stop();
    }
  }

  removeService(id: string): void {
    const service = this.services.get(id);
    if (service) {
      service.dispose();
      this.services.delete(id);
      this.emit('service-removed', id);
    }
  }

  dispose(): void {
    for (const service of this.services.values()) {
      service.dispose();
    }
    this.services.clear();
    this.removeAllListeners();
  }
}
