// Presets: each fills in the endpoint and a default model of an access point.

import type { AccessPoint, AccessPointType } from "../core/types";
import { ANTHROPIC_MESSAGES_URL } from "./anthropic";
import { CHATGPT_RESPONSES_URL } from "./chatgpt";
import { validateEndpoint } from "./http";
import { OPENAI_DECISIONS_URL } from "./openaiDecisions";

export interface Preset {
  id: string;
  type: AccessPointType;
  /** Display name. Provider names are not translated. */
  name: string;
  endpoint: string;
  model: string;
  /** False for local servers, which usually need no key. */
  keyRequired: boolean;
}

export const CLOUDFLARE_ACCOUNT_PLACEHOLDER = "<account id>";

export const PRESETS: readonly Preset[] = [
  {
    id: "jev",
    type: "systemone",
    name: "Jev (TypeSafe)",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    keyRequired: true,
  },
  {
    id: "openrouter-decisions",
    type: "systemone",
    name: "OpenRouter Decisions",
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    model: "~typesafe/jev-latest",
    keyRequired: true,
  },
  {
    id: "cloudflare-clef",
    type: "systemone",
    name: "Cloudflare Clef",
    endpoint: `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_PLACEHOLDER}/ai/run/@cf/cloudflare/clef`,
    model: "clef",
    keyRequired: true,
  },
  {
    id: "local-systemone",
    type: "systemone",
    name: "Local decision model (basal, Bielik-One)",
    endpoint: "http://localhost:8000/v1/systemone",
    model: "",
    keyRequired: false,
  },
  {
    id: "openai-decisions",
    type: "openai-decisions",
    name: "OpenAI Decisions",
    endpoint: OPENAI_DECISIONS_URL,
    model: "gpt-6-luna",
    keyRequired: true,
  },
  {
    id: "openai",
    type: "openai-chat",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-6-luna",
    keyRequired: true,
  },
  {
    id: "gemini",
    type: "openai-chat",
    name: "Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-4-hydrogen",
    keyRequired: true,
  },
  {
    id: "openrouter",
    type: "openai-chat",
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    model: "openai/gpt-6-luna",
    keyRequired: true,
  },
  {
    id: "ollama",
    type: "openai-chat",
    name: "Ollama",
    endpoint: "http://localhost:11434/v1",
    model: "qwen3:8b",
    keyRequired: false,
  },
  {
    id: "lmstudio",
    type: "openai-chat",
    name: "LM Studio",
    endpoint: "http://localhost:1234/v1",
    model: "",
    keyRequired: false,
  },
  {
    id: "custom",
    type: "openai-chat",
    name: "Custom (OpenAI-compatible)",
    endpoint: "",
    model: "",
    keyRequired: false,
  },
  {
    id: "anthropic",
    type: "anthropic",
    name: "Claude (Anthropic API key)",
    endpoint: ANTHROPIC_MESSAGES_URL,
    model: "claude-opus-5-5",
    keyRequired: true,
  },
  {
    id: "chatgpt",
    type: "chatgpt",
    name: "ChatGPT plan",
    endpoint: CHATGPT_RESPONSES_URL,
    model: "",
    keyRequired: false,
  },
];

/** Types whose endpoint is fixed by the provider and cannot be edited. */
export const FIXED_ENDPOINTS: Partial<Record<AccessPointType, string>> = {
  "openai-decisions": OPENAI_DECISIONS_URL,
  anthropic: ANTHROPIC_MESSAGES_URL,
  chatgpt: CHATGPT_RESPONSES_URL,
};

/** Types that cannot work without an API key. */
export const KEY_REQUIRED_TYPES: readonly AccessPointType[] = ["openai-decisions", "anthropic"];

export type DefinitionProblem =
  | "name-missing"
  | "endpoint-invalid"
  | "endpoint-insecure"
  | "endpoint-placeholder"
  | "model-missing"
  | "key-missing";

/** The editable part of an access point. */
export interface AccessPointDefinition {
  type: AccessPointType;
  name: string;
  enabled: boolean;
  endpoint: string;
  model: string;
}

/** Applies fixed endpoints and trims fields. */
export function normalizeDefinition(definition: AccessPointDefinition): AccessPointDefinition {
  return {
    type: definition.type,
    name: definition.name.trim(),
    enabled: definition.enabled,
    endpoint: FIXED_ENDPOINTS[definition.type] ?? definition.endpoint.trim(),
    model: definition.model.trim(),
  };
}

/** Checks a definition before it is saved. Returns the problems found. */
export function checkDefinition(definition: AccessPointDefinition, hasKey: boolean): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  if (definition.name.trim() === "") {
    problems.push("name-missing");
  }
  if (/[<>]/.test(definition.endpoint)) {
    problems.push("endpoint-placeholder");
  } else {
    const endpoint = validateEndpoint(definition.endpoint);
    if (!endpoint.ok) {
      problems.push(endpoint.reason === "insecure" ? "endpoint-insecure" : "endpoint-invalid");
    }
  }
  const modelOptional = definition.type === "systemone" || definition.type === "chatgpt";
  if (!modelOptional && definition.model.trim() === "") {
    problems.push("model-missing");
  }
  if (KEY_REQUIRED_TYPES.includes(definition.type) && !hasKey) {
    problems.push("key-missing");
  }
  return problems;
}

export function newAccessPoint(id: string, definition: AccessPointDefinition, apiKey: string): AccessPoint {
  const normalized = normalizeDefinition(definition);
  return {
    id,
    ...normalized,
    apiKey,
    auth: null,
    cooldownUntil: 0,
    needsAttention: false,
    lastError: "",
  };
}
