/**
 * Anthropic Provider (Claude models)
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  JudgmentProvider,
  JudgmentRequest,
  JudgmentResponse,
  RespondRequest,
  RespondResponse,
  ProviderConfig,
} from './provider';
import {
  buildJudgmentSystemPrompt,
  buildJudgmentUserPrompt,
  buildRespondSystemPrompt,
  buildRespondUserPrompt,
  parseJudgmentResponse,
} from './provider';

export class AnthropicProvider implements JudgmentProvider {
  name = 'Anthropic';

  async judge(
    request: JudgmentRequest,
    config: ProviderConfig
  ): Promise<JudgmentResponse> {
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Anthropic API key not configured. Set ANTHROPIC_API_KEY in environment or configure per-model.'
      );
    }

    const client = new Anthropic({ apiKey });
    const systemPrompt = buildJudgmentSystemPrompt(
      request.rubricName,
      request.rubricDescription,
      request.rubricCriteria
    );
    const userPrompt = buildJudgmentUserPrompt(request);

    const startTime = Date.now();

    const response = await client.messages.create({
      model: config.modelId,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const latencyMs = Date.now() - startTime;

    const rawText =
      response.content[0].type === 'text' ? response.content[0].text : '';
    const tokenCount =
      (response.usage?.input_tokens || 0) +
      (response.usage?.output_tokens || 0);

    return parseJudgmentResponse(
      rawText,
      request.rubricCriteria,
      latencyMs,
      tokenCount
    );
  }

  async respond(
    request: RespondRequest,
    config: ProviderConfig
  ): Promise<RespondResponse> {
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Anthropic API key not configured. Set ANTHROPIC_API_KEY in environment or configure per-model.'
      );
    }

    const client = new Anthropic({ apiKey });
    const systemPrompt = buildRespondSystemPrompt();
    const userPrompt = buildRespondUserPrompt(request);
    const startTime = Date.now();

    const response = await client.messages.create({
      model: config.modelId,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const latencyMs = Date.now() - startTime;
    const rawText =
      response.content[0].type === 'text' ? response.content[0].text : '';
    const tokenCount =
      (response.usage?.input_tokens || 0) +
      (response.usage?.output_tokens || 0);

    return {
      responseText: rawText.trim(),
      rawResponse: rawText,
      latencyMs,
      tokenCount,
    };
  }
}
