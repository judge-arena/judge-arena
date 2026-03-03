/**
 * LLM Provider Abstraction Layer
 *
 * Unified interface for calling different LLM providers (Anthropic, OpenAI, Local).
 * Each provider implements the JudgmentProvider interface to produce structured evaluations.
 */

import type { CriteriaScore, RubricCriterionView } from '@/types';

export interface JudgmentRequest {
  inputText?: string;
  promptText?: string;
  responseText?: string;
  rubricCriteria: RubricCriterionView[];
  rubricName: string;
  rubricDescription?: string;
}

export interface JudgmentResponse {
  overallScore: number;
  reasoning: string;
  criteriaScores: CriteriaScore[];
  rawResponse: string;
  latencyMs: number;
  tokenCount?: number;
}

export interface ProviderConfig {
  apiKey?: string;
  endpoint?: string;
  modelId: string;
}

export interface JudgmentProvider {
  name: string;
  judge(request: JudgmentRequest, config: ProviderConfig): Promise<JudgmentResponse>;
}

/**
 * Build the system prompt for LLM-as-a-Judge evaluation
 */
export function buildJudgmentSystemPrompt(
  rubricName: string,
  rubricDescription: string | undefined,
  criteria: RubricCriterionView[]
): string {
  const criteriaList = criteria
    .sort((a, b) => a.order - b.order)
    .map(
      (c, i) =>
        `${i + 1}. **${c.name}** (max score: ${c.maxScore}, weight: ${c.weight})\n   ${c.description}`
    )
    .join('\n');

  return `You are an expert evaluator acting as an impartial judge. Your task is to evaluate a submission according to a specific grading rubric.

## Rubric: ${rubricName}
${rubricDescription ? `\n${rubricDescription}\n` : ''}
## Evaluation Criteria
${criteriaList}

## Instructions
1. Read the submission carefully.
2. If a prompt and response are provided, evaluate the response in context of the prompt.
3. If only one text artifact is provided, evaluate that artifact directly.
4. Evaluate against EACH criterion independently.
5. Provide a score for each criterion (0 to its max score).
6. Write a brief justification for each score.
7. Calculate an overall weighted score.
8. Provide overall reasoning for your judgment.

## Response Format
You MUST respond with valid JSON in exactly this format:
{
  "overallScore": <number 0-10>,
  "reasoning": "<overall assessment string>",
  "criteriaScores": [
    {
      "criterionId": "<criterion id>",
      "criterionName": "<criterion name>",
      "score": <number>,
      "maxScore": <max score>,
      "weight": <weight>,
      "comment": "<brief justification>"
    }
  ]
}

Be fair, thorough, and consistent in your evaluation. Do not be overly generous or harsh.`;
}

/**
 * Build the user prompt containing the submission to evaluate
 */
export function buildJudgmentUserPrompt(request: {
  inputText?: string;
  promptText?: string;
  responseText?: string;
}): string {
  const promptText = request.promptText?.trim();
  const responseText = request.responseText?.trim();
  const inputText = request.inputText?.trim();

  if (promptText && responseText) {
    return `Please evaluate the following response according to the rubric criteria provided.

## Prompt (Input)
${promptText}

## Response (Output to evaluate)
${responseText}

Evaluate how well the response addresses the prompt.
Respond with your evaluation in the specified JSON format.`;
  }

  if (responseText) {
    return `Please evaluate the following response according to the rubric criteria provided.

## Response (Output to evaluate)
${responseText}

Respond with your evaluation in the specified JSON format.`;
  }

  return `Please evaluate the following submission according to the rubric criteria provided.

## Submission
${inputText ?? ''}

Respond with your evaluation in the specified JSON format.`;
}

/**
 * Parse the LLM response into a structured JudgmentResponse.
 * Handles cases where the model wraps JSON in markdown code blocks.
 */
export function parseJudgmentResponse(
  raw: string,
  criteria: RubricCriterionView[],
  latencyMs: number,
  tokenCount?: number
): JudgmentResponse {
  // Extract JSON from markdown code blocks if present
  let jsonStr = raw.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  const parsed = JSON.parse(jsonStr);

  // Validate and normalize criteria scores
  const criteriaScores: CriteriaScore[] = criteria.map((criterion) => {
    const found = parsed.criteriaScores?.find(
      (cs: CriteriaScore) =>
        cs.criterionId === criterion.id || cs.criterionName === criterion.name
    );

    return {
      criterionId: criterion.id,
      criterionName: criterion.name,
      score: found ? Math.min(Math.max(0, found.score), criterion.maxScore) : 0,
      maxScore: criterion.maxScore,
      weight: criterion.weight,
      comment: found?.comment || '',
    };
  });

  return {
    overallScore: Math.min(Math.max(0, parsed.overallScore || 0), 10),
    reasoning: parsed.reasoning || '',
    criteriaScores,
    rawResponse: raw,
    latencyMs,
    tokenCount,
  };
}
