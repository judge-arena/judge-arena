/**
 * OpenAI-Compatible Provider
 *
 * Supports OpenAI API, as well as any OpenAI-compatible endpoint:
 * - Local models via Ollama (http://localhost:11434/v1)
 * - vLLM, llama.cpp, LM Studio, etc.
 * - Azure OpenAI
 * - Any OpenAI-compatible proxy
 */

import OpenAI from 'openai';
import type {
  JudgmentProvider,
  JudgmentRequest,
  JudgmentResponse,
  ProviderConfig,
} from './provider';
import {
  buildJudgmentSystemPrompt,
  buildJudgmentUserPrompt,
  parseJudgmentResponse,
} from './provider';

export class OpenAICompatibleProvider implements JudgmentProvider {
  name: string;

  constructor(name: string = 'OpenAI') {
    this.name = name;
  }

  async judge(
    request: JudgmentRequest,
    config: ProviderConfig
  ): Promise<JudgmentResponse> {
    const apiKey =
      config.apiKey ||
      process.env.OPENAI_API_KEY ||
      (config.endpoint ? 'not-needed' : undefined);

    if (!apiKey) {
      throw new Error(
        'API key not configured. Set OPENAI_API_KEY in environment or configure per-model.'
      );
    }

    const client = new OpenAI({
      apiKey,
      baseURL: config.endpoint || undefined,
    });

    const systemPrompt = buildJudgmentSystemPrompt(
      request.rubricName,
      request.rubricDescription,
      request.rubricCriteria
    );
    const userPrompt = buildJudgmentUserPrompt(request);

    const startTime = Date.now();

    const response = await client.chat.completions.create({
      model: config.modelId,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    });

    const latencyMs = Date.now() - startTime;

    const rawText = response.choices[0]?.message?.content || '';
    const tokenCount = response.usage
      ? (response.usage.prompt_tokens || 0) +
        (response.usage.completion_tokens || 0)
      : undefined;

    return parseJudgmentResponse(
      rawText,
      request.rubricCriteria,
      latencyMs,
      tokenCount
    );
  }
}
