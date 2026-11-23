// Presets: each fills in the endpoint and a default model of an access point.

import type { AccessPoint, AccessPointType } from "../core/types";
import { ANTHROPIC_MESSAGES_URL } from "./anthropic";
import { CHATGPT_RESPONSES_URL } from "./chatgpt";
import { CHATGPT_ORIGINS } from "./chatgptAuth";
import { originPattern, validateEndpoint } from "./http";
import { OPENAI_DECISIONS_URL } from "./openaiDecisions";

/** How the settings page groups the presets, in the order it shows the groups. */
export const PRESET_GROUPS = ["decision", "chat", "plan", "local"] as const;
export type PresetGroup = (typeof PRESET_GROUPS)[number];

export interface Preset {
  /** Also the key of the display name and of the description in the locale file: preset_<id>, presetHint_<id>. */
  id: string;
  type: AccessPointType;
  endpoint: string;
  model: string;
  /** False for local servers, which usually need no key. */
  keyRequired: boolean;
  group: PresetGroup;
  /** Where the user creates the key. Only for services whose address is certain. */
  keyUrl?: string;
  /** The service's own description of what the preset uses. */
  docsUrl?: string;
}

export const CLOUDFLARE_ACCOUNT_PLACEHOLDER = "<account id>";

export const PRESETS: readonly Preset[] = [
  {
    id: "jev",
    type: "systemone",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    keyRequired: true,
    group: "decision",
    docsUrl: "https://docs.typesafe.ai/api/system-one.md",
  },
  {
    id: "openrouter-decisions",
    type: "systemone",
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    model: "~typesafe/jev-latest",
    keyRequired: true,
    group: "decision",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "cloudflare-clef",
    type: "systemone",
    endpoint: `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_PLACEHOLDER}/ai/run/@cf/cloudflare/clef`,
    model: "clef",
    keyRequired: true,
    group: "decision",
    docsUrl: "https://developers.cloudflare.com/workers-ai/models/clef/",
  },
  {
    id: "local-systemone",
    type: "systemone",
    endpoint: "http://localhost:8000/v1/systemone",
    model: "",
    keyRequired: false,
    group: "local",
    docsUrl: "https://github.com/rkinas/basal",
  },
  {
    id: "openai-decisions",
    type: "openai-decisions",
    endpoint: OPENAI_DECISIONS_URL,
    model: "gpt-6-luna",
    keyRequired: true,
    group: "decision",
    keyUrl: "https://platform.openai.com/api-keys",
    docsUrl: "https://developers.openai.com/api/docs/guides/decisions",
  },
  {
    id: "openai",
    type: "openai-chat",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-6-luna",
    keyRequired: true,
    group: "chat",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    type: "openai-chat",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-4-hydrogen",
    keyRequired: true,
    group: "chat",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    type: "openai-chat",
    endpoint: "https://openrouter.ai/api/v1",
    model: "openai/gpt-6-luna",
    keyRequired: true,
    group: "chat",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "ollama",
    type: "openai-chat",
    endpoint: "http://localhost:11434/v1",
    model: "qwen3:8b",
    keyRequired: false,
    group: "local",
  },
  {
    id: "lmstudio",
    type: "openai-chat",
    endpoint: "http://localhost:1234/v1",
    model: "",
    keyRequired: false,
    group: "local",
  },
  {
    id: "custom",
    type: "openai-chat",
    endpoint: "",
    model: "",
    keyRequired: false,
    group: "chat",
  },
  {
    id: "anthropic",
    type: "anthropic",
    endpoint: ANTHROPIC_MESSAGES_URL,
    model: "claude-sonnet-5-5",
    keyRequired: true,
    group: "chat",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "chatgpt",
    type: "chatgpt",
    endpoint: CHATGPT_RESPONSES_URL,
    model: "",
    keyRequired: false,
    group: "plan",
    docsUrl: "https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites",
  },
];

/** Types whose endpoint is fixed by the provider and cannot be edited. */
export const FIXED_ENDPOINTS: Partial<Record<AccessPointType, string>> = {
  "openai-decisions": OPENAI_DECISIONS_URL,
  anthropic: ANTHROPIC_MESSAGES_URL,
  chatgpt: CHATGPT_RESPONSES_URL,
};

/**
 * The host permissions the requests of an access point need: the host it really
 * contacts (the fixed endpoint of a provider-bound type), both OpenAI hosts for the
 * ChatGPT plan. Null when the address is not valid.
 */
export function requiredOrigins(point: Pick<AccessPoint, "type" | "endpoint">): string[] | null {
  if (point.type === "chatgpt") {
    return [...CHATGPT_ORIGINS];
  }
  const checked = validateEndpoint(FIXED_ENDPOINTS[point.type] ?? point.endpoint);
  return checked.ok ? [originPattern(checked.url)] : null;
}

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

/**
 * Checks an access point definition from an import file with the checks of Save,
 * without the key, which is never exported. The endpoint of a provider-bound type is
 * fixed first, so a file cannot name another host for it.
 */
export function checkImportedDefinition(definition: AccessPointDefinition): {
  definition: AccessPointDefinition;
  problems: DefinitionProblem[];
} {
  const normalized = normalizeDefinition(definition);
  return { definition: normalized, problems: checkDefinition(normalized, true) };
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
