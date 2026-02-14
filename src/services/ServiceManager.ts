import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { SpringBootService } from './SpringBootService';
import { ServiceInfo, AnalysisResult, ErrorBlock } from '../types';

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

    if ((hasGradle || hasMaven) && hasSrcMain) {
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
    service.start(apiKey, model, maxRequests, profiles || undefined, jvmArgs || undefined);
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
