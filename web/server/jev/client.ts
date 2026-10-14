import { AuthenticationError, PermissionDeniedError, TypeSafeClient } from "@typesafe-ai/sdk";
import { JEV_MODEL } from "./questions.ts";

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, unknown> }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };
export type JevQuestions = Record<string, JevQuestion>;

export type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };

export interface JevResult {
  answers: Record<string, Answer>;
  model: string;
  requestId?: string;
}

/** What the router needs from Jev. `TypeSafeJev` is the real one; tests use a fake. */
export interface JevClient {
  ask(state: object, questions: JevQuestions, signal?: AbortSignal): Promise<JevResult>;
}

/** The key was rejected; the router turns itself off rather than failing every command. */
export class JevAuthError extends Error {
  constructor() {
    super("Jev rejected TYPESAFE_API_KEY.");
  }
}

/**
 * Jev over the TypeSafe SDK, tuned for a live voice path: one short attempt and one retry, so a slow
 * or failing Jev costs at most a moment before the command falls back to Claude.
 */
export class TypeSafeJev implements JevClient {
  private client: TypeSafeClient;

  constructor(apiKey: string, timeoutMs = 1_500) {
    this.client = new TypeSafeClient({
      apiKey,
      defaultModel: JEV_MODEL,
      timeout: timeoutMs,
      retry: { maxRetries: 1, backoffInitialMs: 100, backoffMaxMs: 200 },
      logLevel: "warn",
    });
  }

  async ask(state: object, questions: JevQuestions, signal?: AbortSignal): Promise<JevResult> {
    try {
      const { data, requestId } = await this.client
        .systemOne({ state: state as never, questions: questions as never, model: JEV_MODEL }, { signal })
        .withResponse();
      return { answers: data.answers as unknown as Record<string, Answer>, model: data.model, requestId: requestId ?? undefined };
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) throw new JevAuthError();
      throw err;
    }
  }
}

/** The real client when a key is set, otherwise null (the router then hands everything to Claude). */
export function jevFromEnv(): JevClient | null {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  return key ? new TypeSafeJev(key) : null;
}
