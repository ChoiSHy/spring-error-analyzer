import Anthropic from '@anthropic-ai/sdk';
import { AnalysisResult, ErrorBlock, CodeContext } from '../types';
import { StackFrameContext } from './CodeContextExtractor';

export class ClaudeAnalyzer {
  private client: Anthropic | null = null;
  private model: string = 'claude-sonnet-4-5-20250929';
  private maxRequestsPerMinute: number = 10;
  private requestTimestamps: number[] = [];

  configure(apiKey: string, model: string, maxRequestsPerMinute: number): void {
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
    this.model = model;
    this.maxRequestsPerMinute = maxRequestsPerMinute;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  private canMakeRequest(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t > oneMinuteAgo);
    return this.requestTimestamps.length < this.maxRequestsPerMinute;
  }

  private recordRequest(): void {
    this.requestTimestamps.push(Date.now());
  }

  async analyze(error: ErrorBlock, codeContexts?: StackFrameContext[]): Promise<AnalysisResult | null> {
    if (!this.client) {
      return null;
    }

    if (!this.canMakeRequest()) {
      return {
        errorId: error.id,
        serviceId: error.serviceId,
        analysisType: 'ai',
        title: 'Rate Limited',
        description: 'AI 분석 요청이 분당 최대 횟수를 초과했습니다.',
        suggestion: '잠시 후 다시 시도해주세요.',
        confidence: 0,
        timestamp: new Date().toISOString(),
        errorBlock: error,
      };
    }

    try {
      this.recordRequest();

      const stackTraceText =
        error.stackTrace.length > 0
          ? '\n\nStack Trace:\n' + error.stackTrace.slice(0, 50).join('\n')
          : '';

      // 소스 코드 컨텍스트 섹션 구성
      let codeContextSection = '';
      if (codeContexts && codeContexts.length > 0) {
        codeContextSection = '\n\n관련 소스 코드 (에러 발생 위치, >>> 마커가 해당 라인):';
        for (const ctx of codeContexts) {
          codeContextSection +=
            `\n\n[${ctx.className}.${ctx.methodName}() ` +
            `- ${ctx.fileName}:${ctx.lineNumber}]\n` +
            '```\n' + ctx.codeSnippet + '\n```';
        }
      }

      const prompt = `You are a Spring Boot error analysis expert. Analyze the following error and provide:
1. A concise title for this error (in Korean)
2. A clear description of what went wrong (in Korean)
3. Step-by-step suggestions to fix it (in Korean) — if source code is provided, reference specific line numbers or variable names
4. Confidence level (0.0 to 1.0) based on how certain you are about the analysis

Error Message: ${error.message}
Logger: ${error.logger}
Thread: ${error.thread}
Timestamp: ${error.timestamp}${stackTraceText}${codeContextSection}

Respond ONLY in the following JSON format (no markdown, no code blocks):
{"title": "...", "description": "...", "suggestion": "...", "confidence": 0.0}`;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        return null;
      }

      // Strip markdown code block wrappers if present (```json ... ``` or ``` ... ```)
      let jsonText = content.text.trim();
      const codeBlockMatch = jsonText.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
      if (codeBlockMatch) {
        jsonText = codeBlockMatch[1].trim();
      }

      const parsed = JSON.parse(jsonText);

      // StackFrameContext → CodeContext (filePath 제외, webview 전송용)
      const mappedContexts: CodeContext[] | undefined = codeContexts && codeContexts.length > 0
        ? codeContexts.map(({ className, methodName, fileName, lineNumber, codeSnippet }) => ({
            className, methodName, fileName, lineNumber, codeSnippet,
          }))
        : undefined;

      return {
        errorId: error.id,
        serviceId: error.serviceId,
        analysisType: 'ai',
        title: parsed.title || 'AI Analysis',
        description: parsed.description || '',
        suggestion: parsed.suggestion || '',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
        timestamp: new Date().toISOString(),
        errorBlock: error,
        codeContexts: mappedContexts,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        errorId: error.id,
        serviceId: error.serviceId,
        analysisType: 'ai',
        title: 'AI Analysis Failed',
        description: `Claude API 호출 중 오류가 발생했습니다: ${errorMessage}`,
        suggestion: '1. API 키가 올바른지 확인하세요.\n2. 네트워크 연결을 확인하세요.\n3. API 사용량 한도를 확인하세요.',
        confidence: 0,
        timestamp: new Date().toISOString(),
        errorBlock: error,
      };
    }
  }
}
