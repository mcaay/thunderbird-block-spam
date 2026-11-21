// The adapter registry: one scoring operation per access point type.

import { DIAGNOSTICS, permissionDiagnostic } from "../core/diagnostics";
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
import { requiredOrigins } from "./presets";
import { scoreSystemOne } from "./systemOne";

export { requiredOrigins } from "./presets";

export interface AiDeps {
  fetch: FetchLike;
  now: () => number;
  /** Stores the access points, including renewed sign-in tokens. */
  persist: () => Promise<void>;
  /** True when this computer granted the host permission for a match pattern such as https://api.openai.com/*. */
  hasHostPermission: (pattern: string) => Promise<boolean>;
}

export interface Ai extends AiPort {
  /** Models an access point offers. Empty for types without a model list. */
  listModels(point: AccessPoint): Promise<ModelOption[]>;
}

export function createAi(deps: AiDeps): Ai {
  /**
   * The host permission is the record of the user's consent on this computer: it is
   * granted only by saving the access point after the consent dialog. Nothing is sent
   * to a host without it, also when a server would answer a request without it.
   */
  async function checkAccess(point: AccessPoint): Promise<void> {
    // Endpoints on loopback addresses may use http, all others must use https.
    const origins = requiredOrigins(point);
    if (origins === null) {
      throw new AccessPointError("transient", DIAGNOSTICS.endpointInvalid);
    }
    for (const origin of origins) {
      if (!(await deps.hasHostPermission(origin))) {
        throw new AccessPointError("auth", permissionDiagnostic(origin));
      }
    }
  }

  return {
    async score(point, prompt, payload) {
      await checkAccess(point);
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
        await checkAccess(point);
        return listChatGptModels(point, deps);
      }
      if (point.type === "openai-chat" && validateEndpoint(point.endpoint).ok) {
        await checkAccess(point);
        return listOpenAiChatModels(point, deps);
      }
      return [];
    },
  };
}

export type { ModelOption } from "./openaiChat";
