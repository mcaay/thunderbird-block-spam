// The adapter registry: one scoring operation per access point type.

import { AccessPointError } from "../core/chain";
import type { AiPort } from "../core/ports";
import type { AccessPoint } from "../core/types";
import { scoreAnthropic } from "./anthropic";
import { listChatGptModels, scoreChatGpt } from "./chatgpt";
import type { FetchLike } from "./http";
import { validateEndpoint } from "./http";
import { listOpenAiChatModels, scoreOpenAiChat } from "./openaiChat";
import type { ModelOption } from "./openaiChat";
import { scoreOpenAiDecisions } from "./openaiDecisions";
import { scoreSystemOne } from "./systemOne";

export interface AiDeps {
  fetch: FetchLike;
  now: () => number;
  /** Stores the access points, including renewed sign-in tokens. */
  persist: () => Promise<void>;
}

export interface Ai extends AiPort {
  /** Models an access point offers. Empty for types without a model list. */
  listModels(point: AccessPoint): Promise<ModelOption[]>;
}

export function createAi(deps: AiDeps): Ai {
  return {
    async score(point, prompt, payload) {
      // Endpoints on loopback addresses may use http, all others must use https.
      if (!validateEndpoint(point.endpoint).ok) {
        throw new AccessPointError("transient", "the endpoint address is not valid");
      }
      switch (point.type) {
        case "systemone":
          return scoreSystemOne(point, prompt, payload, deps);
        case "openai-decisions":
          return scoreOpenAiDecisions(point, prompt, payload, deps);
        case "openai-chat":
          return scoreOpenAiChat(point, prompt, payload, deps);
        case "anthropic":
          return scoreAnthropic(point, prompt, payload, deps);
        case "chatgpt":
          return scoreChatGpt(point, prompt, payload, deps);
      }
    },
    async listModels(point) {
      if (point.type === "chatgpt") {
        return listChatGptModels(point, deps);
      }
      if (point.type === "openai-chat" && validateEndpoint(point.endpoint).ok) {
        return listOpenAiChatModels(point, deps);
      }
      return [];
    },
  };
}

export type { ModelOption } from "./openaiChat";
