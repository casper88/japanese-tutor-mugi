// LLM backend seam for the chat server (server/claudeChat.ts). Every upstream call goes through an LlmProvider.
// The request format is the Anthropic Messages shape that claudeChat builds (chatRequest: a stable system block with its
// cache breakpoint, the volatile reminder on the newest user turn). anthropicProvider sends it unchanged; openaiProvider
// converts it to the OpenAI Responses shape (server/llm/openaiProvider.ts); localProvider converts it to the Chat Completions
// shape of an OpenAI-compatible local server (server/llm/localProvider.ts).
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ClaudeUsage } from '../usage.ts';
import type { ProviderId } from '../../src/game/claudeProtocol.ts';

/**
 * The chat request (claudeChat.chatRequest). `schemaName` names the JSON schema for OpenAI's strict json_schema (the Anthropic
 * provider never sends it: it is stripped before the SDK call).
 */
export type LlmChatRequest = BetaMessageStreamParams & { schemaName?: string };

/** A one-shot request (judge, tip rewrite, lookup): plain system text and user/assistant messages. */
export type LlmCompleteRequest = {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** thinking off for the fixed-model helpers (Anthropic only) */
  thinking?: { type: 'disabled' };
  /** effort, and a JSON schema the reply must match (judge; Anthropic only) */
  output_config?: { effort?: 'low'; format?: { type: 'json_schema'; schema: Record<string, unknown> } };
  /** the name of the schema for OpenAI's strict json_schema (mugi_judge, mugi_tip, mugi_lookup); stripped for Anthropic */
  schemaName?: string;
};

export type LlmCompleteOptions = { timeout?: number };

export type LlmResult = {
  /** the whole reply text */
  text: string;
  model?: string;
  usage?: ClaudeUsage;
  stopReason?: string | null;
};

export type LlmStream = {
  /** stop the upstream request (the client went away) */
  abort(): void;
  /** resolves with the whole reply once the stream ends; rejects on upstream failure, abort or the total time limit */
  done: Promise<LlmResult>;
  /**
   * the usage the upstream has reported so far; undefined when none came yet. Mid-stream this is only the input (message_start)
   * and a very small output (message_start carries output_tokens of about 1); the real output count comes on message_delta at
   * the end, so an early end is recorded with the reply length as its output (claudeChat.recordStreamSpend).
   */
  usageSoFar(): ClaudeUsage | undefined;
};

export interface LlmProvider {
  id: ProviderId;
  /**
   * true for a small local model: the prompt is shaped for it (tested on Qwen3 4B, which copied the example of the full
   * reminder and drifted away from what the player said). Its reminder has no example to copy and comes before the player's
   * words, and the server writes every kanji reading itself: the model is told not to write them, the readings in the history
   * it is sent are removed, and any it writes anyway are removed before kuromoji fills them all in (server/readings.ts).
   */
  smallModel?: boolean;
  /** deltas go to onDelta as they arrive; the returned stream carries the end */
  streamChat(req: LlmChatRequest, onDelta: (text: string) => void): LlmStream;
  complete(req: LlmCompleteRequest, opts?: LlmCompleteOptions): Promise<LlmResult>;
  /** upstream failure → HTTP status and a message for the player (never a key or a token) */
  describeError(e: unknown): { status: number; message: string };
}


/** Generic failure mapping: the message of an Error, status 500. */
export function defaultDescribeError(e: unknown): { status: number; message: string } {
  return { status: 500, message: e instanceof Error ? e.message : '未知錯誤' };
}
