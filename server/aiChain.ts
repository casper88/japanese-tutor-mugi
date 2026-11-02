// The AI service order (see the Settings › AI 服務): each AI request says which services to try and in which order
// (`providers`), and the server tries them in that order. This module holds the pure parts: the body fields, the rule for
// which errors move on to the next service, and the one-shot run over a list of services.
import Anthropic from '@anthropic-ai/sdk';
import { OPENAI_MODEL_MAX_CHARS, PROVIDERS_MAX, PROVIDER_IDS, parseProviderList, DEFAULT_PROVIDERS, type ProviderId } from '../src/game/claudeProtocol.ts';
import type { LlmProvider } from './llm/provider.ts';

/** a service ready for one request: which one, the model it will use, and the provider that calls it */
export type Service = {
  id: ProviderId;
  model: string;
  provider: LlmProvider;
  /**
   * a Claude service: its spending is recorded (usage.ts). ChatGPT calls use the plan's quota and a local model costs nothing, so
   * neither is recorded as Claude cost.
   */
  spend: boolean;
  /** a Claude service: releases its reservation against the daily cap (claudeChat.ts hold); called when the response is done */
  hold?: () => void;
};

/** the routing of a request: the order of the services and, for ChatGPT, the model (absent = the first listed) */
export type Routing = { providers: ProviderId[]; openaiModel?: string };

export class RoutingError extends Error {
  readonly status = 400;
}

/**
 * The `providers` and `openaiModel` of a body: an absent (or null) providers list is the default (Claude alone). A list that is
 * not 1 to PROVIDERS_MAX known ids, none repeated, is a RoutingError (400). openaiModel: a string up to OPENAI_MODEL_MAX_CHARS, '' = none.
 */
export function parseRouting(v: { providers?: unknown; openaiModel?: unknown }): Routing {
  let providers: ProviderId[] = [...DEFAULT_PROVIDERS];
  if (v.providers !== undefined && v.providers !== null) {
    const list = parseProviderList(v.providers);
    if (!list) throw new RoutingError(`providers 需為 1 到 ${PROVIDERS_MAX} 個不重複的服務（${PROVIDER_IDS.join('、')}）`);
    providers = list;
  }
  let openaiModel: string | undefined;
  if (v.openaiModel !== undefined && v.openaiModel !== null) {
    if (typeof v.openaiModel !== 'string' || v.openaiModel.length > OPENAI_MODEL_MAX_CHARS) {
      throw new RoutingError(`openaiModel 需為最多 ${OPENAI_MODEL_MAX_CHARS} 字的字串`);
    }
    if (v.openaiModel.trim()) openaiModel = v.openaiModel.trim();
  }
  return { providers, ...(openaiModel ? { openaiModel } : {}) };
}

/** the routing of a raw JSON body (the one-shot routes read it next to their own fields); throws RoutingError or a SyntaxError */
export function routingOf(raw: string): Routing {
  return parseRouting(JSON.parse(raw) as { providers?: unknown; openaiModel?: unknown });
}

const OPENAI_TRANSIENT = /usage_limit|usage_unavailable|rate_limit|insufficient|quota|overloaded|server_error|invalid_request/i;

/**
 * Whether an error moves the request on to the next service. Yes: a refused or unauthorised request (400, 401, 403, 404),
 * limits and quota (429), server errors (5xx), a time limit, a dropped connection, and the codes that name a limit. No: a
 * caller's abort, and anything else (a reply that is not usable is not the service's fault and is not retried elsewhere).
 */
export function fallbackWorthy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; status?: unknown; timeout?: unknown; code?: unknown; message?: unknown };
  if (e.name === 'AbortError' || e.name === 'APIUserAbortError' || error instanceof Anthropic.APIUserAbortError) return false;
  if (e.timeout === true || error instanceof Anthropic.APIConnectionError || error instanceof TypeError) return true;
  if (typeof e.status === 'number') return [400, 401, 403, 404, 429].includes(e.status) || e.status >= 500;
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  return OPENAI_TRANSIENT.test(code) || OPENAI_TRANSIENT.test(message);
}

/** the outcome of a run over the services: the value and who served it, or the last failure and who failed */
export type ServingAttempt<T> = { ok: true; value: T; served: Service } | { ok: false; error: unknown; failed: Service };

/**
 * Runs `run` on the services in order. A failure that fallbackWorthy accepts moves on to the next service; any other failure
 * ends the run there. `services` must not be empty (the caller answers 503 before that).
 */
export async function firstServing<T>(services: Service[], run: (service: Service) => Promise<T>): Promise<ServingAttempt<T>> {
  if (!services.length) throw new Error('no AI service is ready');
  let last: { error: unknown; failed: Service } | undefined;
  for (const service of services) {
    try {
      return { ok: true, value: await run(service), served: service };
    } catch (error) {
      last = { error, failed: service };
      if (!fallbackWorthy(error)) break;
    }
  }
  return { ok: false, error: last?.error, failed: last?.failed as Service };
}
