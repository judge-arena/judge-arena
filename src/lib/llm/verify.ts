import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export interface VerifyModelInput {
  provider: 'anthropic' | 'openai' | 'local';
  modelId: string;
  endpoint?: string;
  apiKey?: string;
}

export async function verifyModelConnection(input: VerifyModelInput): Promise<void> {
  if (input.provider === 'anthropic') {
    const apiKey = input.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('Missing Anthropic API key');
    }

    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: input.modelId,
      max_tokens: 1,
      temperature: 0,
      system: 'Connection test. Reply with ok.',
      messages: [{ role: 'user', content: 'ok' }],
    });
    return;
  }

  const apiKey =
    input.apiKey ||
    process.env.OPENAI_API_KEY ||
    'dummy-key';

  const client = new OpenAI({
    apiKey,
    ...(input.endpoint ? { baseURL: input.endpoint } : {}),
  });

  await client.chat.completions.create({
    model: input.modelId,
    messages: [{ role: 'user', content: 'ok' }],
    max_tokens: 1,
    temperature: 0,
  });
}
