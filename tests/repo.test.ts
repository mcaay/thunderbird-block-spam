// Checks that hold for the repository as a whole: strings, the manifest, layering
// and rules from the design specification that are easy to break by accident.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PRESET_GROUPS, PRESETS } from "../src/ai/presets";
import { COMMANDS } from "../src/core/commands";
import { REASONS } from "../src/core/decision";
import { ACCESS_POINT_TYPES, DEFAULT_PROMPT } from "../src/core/settings";
// @ts-expect-error The build scripts are plain JavaScript modules.
import { crc32, createZip } from "../scripts/zip.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");

function filesUnder(directory: string, extensions: string[]): string[] {
  const found: string[] = [];
  for (const name of readdirSync(path.join(root, directory))) {
    const relative = path.join(directory, name);
    if (statSync(path.join(root, relative)).isDirectory()) {
      found.push(...filesUnder(relative, extensions));
    } else if (extensions.some((extension) => name.endsWith(extension))) {
      found.push(relative);
    }
  }
  return found;
}

const sourceFiles = filesUnder("src", [".ts", ".html"]).filter((file) => !file.endsWith("publicDomains.ts"));
const messages = JSON.parse(read("src/_locales/en/messages.json")) as Record<string, { message: string }>;
const manifest = JSON.parse(read("src/manifest.json")) as Record<string, unknown>;

describe("strings", () => {
  /** String literals passed as the first argument of t(...), including both branches of a ternary. */
  function literalKeys(source: string): string[] {
    const keys: string[] = [];
    for (const match of source.matchAll(/\bt\(/g)) {
      let depth = 0;
      let end = match.index + match[0].length;
      for (; end < source.length; end += 1) {
        const char = source[end];
        if (char === "(" || char === "[") {
          depth += 1;
        } else if (char === ")" || char === "]") {
          if (depth === 0) {
            break;
          }
          depth -= 1;
        } else if (char === "," && depth === 0) {
          break;
        }
      }
      const argument = source.slice(match.index + match[0].length, end);
      for (const literal of argument.matchAll(/"([A-Za-z][A-Za-z0-9_]*)"/g)) {
        // Skip the compared values of a ternary condition such as list === "black".
        const before = argument.slice(0, literal.index).trimEnd();
        if (!before.endsWith("===") && !before.endsWith("!==")) {
          keys.push(literal[1] as string);
        }
      }
    }
    return keys;
  }

  const codeKeys: Record<string, readonly string[]> = {
    source: ["identity", "sent", "scan", "ai", "manual"],
    problem: ["name-missing", "endpoint-invalid", "endpoint-insecure", "endpoint-placeholder", "model-missing", "key-missing"],
    // Mistakes a user can make: the codes of ValidationError that the pages translate.
    invalid: ["entry-invalid", "address-invalid", "account-unknown", "cutoff-range", "prompt-empty", "own-address", "no-sender", "import-invalid"],
    remedy: ["sign-in", "permission", "key-missing", "key-rejected", "plan-refused"],
    endpointHint: ["systemone", "openai-chat"],
    modelHint: ACCESS_POINT_TYPES,
    type: ACCESS_POINT_TYPES,
    outcome: ["trusted", "blocked", "spam", "passed", "no-verdict", "released", "error"],
    action: ["junk", "screening", "inbox"],
    actionObserved: ["junk", "screening", "inbox"],
    reason: [...Object.values(REASONS), "failed"],
    preset: PRESETS.map((preset) => preset.id),
    presetHint: PRESETS.map((preset) => preset.id),
    presetGroup: PRESET_GROUPS,
    signInError: [
      "state-mismatch",
      "wrong-address",
      "denied",
      "provider-error",
      "no-code",
      "registration-incomplete",
      "client-mismatch",
      "exchange-failed",
      "invalid-token",
      "account-mismatch",
      "plan-not-enabled",
    ],
  };

  const PLURAL_FORMS = ["one", "few", "many"] as const;
  const used = new Set<string>();
  for (const file of sourceFiles) {
    const source = read(file);
    for (const key of literalKeys(source)) {
      used.add(key);
    }
    for (const match of source.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([A-Za-z0-9_]+)"/g)) {
      used.add(match[1] as string);
    }
    // A counted string has three forms: tn("key", count) reads key_one, key_few or key_many.
    for (const match of source.matchAll(/\btn\(\s*"([A-Za-z0-9_]+)"/g)) {
      for (const form of PLURAL_FORMS) {
        used.add(`${match[1] as string}_${form}`);
      }
    }
    for (const match of source.matchAll(/"(cmd[A-Z][A-Za-z]+)"/g)) {
      used.add(match[1] as string);
    }
  }
  for (const match of read("src/manifest.json").matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    used.add(match[1] as string);
  }
  for (const [prefix, codes] of Object.entries(codeKeys)) {
    for (const code of codes) {
      used.add(`${prefix}_${code.replace(/[^A-Za-z0-9]/g, "_")}`);
    }
  }

  it("has a message for every key the code uses", () => {
    expect([...used].filter((key) => messages[key] === undefined).sort()).toEqual([]);
  });

  it("has no message that nothing uses", () => {
    expect(Object.keys(messages).filter((key) => !used.has(key)).sort()).toEqual([]);
  });

  it("covers every code prefix that the code looks up", () => {
    const prefixes = new Set<string>();
    for (const file of sourceFiles) {
      for (const match of read(file).matchAll(/tCode\(\s*"([A-Za-z]+)"/g)) {
        prefixes.add(match[1] as string);
      }
    }
    expect([...prefixes].sort()).toEqual(Object.keys(codeKeys).sort());
  });

  it("uses valid message names and non-empty messages", () => {
    for (const [key, value] of Object.entries(messages)) {
      expect(key).toMatch(/^[A-Za-z0-9_]+$/);
      expect(value.message.trim(), key).not.toBe("");
    }
  });

  it("keeps user-visible text out of the code: no innerHTML and no hard-coded page text", () => {
    for (const file of sourceFiles) {
      const source = read(file);
      expect(source, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
    }
    for (const file of ["src/options/options.html", "src/popup/popup.html"]) {
      const text = read(file)
        .replace(/<title>[^<]*<\/title>/, "")
        .replace(/<[^>]+>/g, "")
        .trim();
      expect(text, file).toBe("");
    }
  });

  it("names every header the AI receives in the texts that ask for consent", async () => {
    const { buildPayload } = await import("../src/core/payload");
    const headers = buildPayload({ from: "a@b.example", replyTo: "c@d.example", to: ["e@f.example"], subject: "S", date: 1, body: "" })
      .split("\n\n")[0]
      ?.split("\n")
      .map((line) => line.slice(0, line.indexOf(":")));
    expect(headers).toEqual(["From", "Reply-To", "To", "Subject", "Date"]);
    const words: Record<string, string> = { From: "the sender", "Reply-To": "Reply-To", To: "the recipients", Subject: "the subject", Date: "the date" };
    for (const key of ["consentWhat", "aiHint"]) {
      for (const header of headers ?? []) {
        expect(messages[key]?.message, `${key}: ${header}`).toContain(words[header]);
      }
    }
  });

  it("contains no en dash and no em dash anywhere in the project", () => {
    const files = [
      ...filesUnder("src", [".ts", ".html", ".css", ".json", ".svg"]),
      ...filesUnder("tests", [".ts"]),
      ...filesUnder("scripts", [".mjs"]),
      ...filesUnder("companion", [".js", ".json", ".md"]),
      ...filesUnder("docs", [".md"]),
      "README.md",
      "THIRD_PARTY_LICENSES.md",
      "package.json",
    ];
    // Built from character codes, so that this file does not contain the characters itself.
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    const offenders = files.filter((file) => dashes.test(read(file)));
    expect(offenders).toEqual([]);
  });
});

describe("manifest of the main add-on", () => {
  const gecko = (manifest.browser_specific_settings as { gecko: Record<string, unknown> }).gecko;

  it("is a Manifest V3 MailExtension for Thunderbird 153 and newer", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(gecko.strict_min_version).toBe("153.0");
    expect(manifest.default_locale).toBe("en");
    expect(manifest.background).toEqual({ scripts: ["background.js"] });
  });

  it("requests exactly the permissions of the specification, and menus for the context menu of the message list", () => {
    expect([...(manifest.permissions as string[])].sort()).toEqual(
      ["accountsRead", "messagesRead", "messagesMove", "compose", "storage", "alarms", "notifications", "menus"].sort(),
    );
    expect([...(manifest.optional_permissions as string[])].sort()).toEqual(["accountsFolders", "webRequest"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]);
  });

  it("never asks for full access: no Experiment and no native messaging", () => {
    const text = read("src/manifest.json");
    expect(manifest.experiment_apis).toBeUndefined();
    expect(text).not.toContain("nativeMessaging");
    expect(text).not.toContain("<all_urls>");
    for (const file of sourceFiles) {
      expect(read(file), file).not.toMatch(/connectNative|sendNativeMessage|ChromeUtils|Services\./);
    }
  });

  it("declares what can be sent to AI providers as optional data collection", () => {
    expect(gecko.data_collection_permissions).toEqual({
      required: ["none"],
      optional: ["personalCommunications", "personallyIdentifyingInfo"],
    });
  });

  it("declares the four commands with the default shortcuts, the same on every platform", () => {
    const commands = manifest.commands as Record<string, { suggested_key: Record<string, string>; description: string }>;
    expect(Object.keys(commands).sort()).toEqual([...COMMANDS].sort());
    expect(commands["block-address"]?.suggested_key).toEqual({ default: "Alt+B" });
    expect(commands["block-domain"]?.suggested_key).toEqual({ default: "Alt+Shift+B" });
    expect(commands["trust-address"]?.suggested_key).toEqual({ default: "Alt+W" });
    expect(commands["trust-domain"]?.suggested_key).toEqual({ default: "Alt+Shift+W" });
  });

  it("can request the host of every preset", () => {
    const patterns = manifest.optional_host_permissions as string[];
    for (const preset of PRESETS) {
      if (preset.endpoint === "") {
        continue;
      }
      const url = new URL(preset.endpoint.replace("<account id>", "x"));
      const allowed = url.protocol === "https:" ? patterns.includes("https://*/*") : patterns.includes(`http://${url.hostname}/*`);
      expect(allowed, preset.id).toBe(true);
    }
  });
});

describe("layering", () => {
  it("keeps src/core free of Thunderbird APIs", () => {
    for (const file of filesUnder("src/core", [".ts"])) {
      const source = read(file);
      expect(source, file).not.toMatch(/\bbrowser\.|\bmessenger\.|from "\.\.\/tb\/|from "\.\.\/ai\/|from "\.\.\/options\//);
    }
  });

  it("lets only the background write storage", () => {
    const writers = sourceFiles.filter((file) => /storage\.local\.(set|remove|clear)\(/.test(read(file)));
    expect(writers).toEqual(["src/tb/store.ts"]);
    for (const file of [...filesUnder("src/options", [".ts"]), ...filesUnder("src/popup", [".ts"])]) {
      expect(read(file), file).not.toMatch(/from "\.\.\/(\.\.\/)?tb\/store"/);
    }
  });

  it("makes network requests only from the access point adapters", () => {
    const callers = sourceFiles.filter((file) => /(?<![.\w])fetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(read(file)));
    expect(callers).toEqual(["src/background.ts"]);
    expect(read("src/background.ts").match(/(?<![.\w])fetch\(/g)).toHaveLength(1);
  });

  it("has one runtime dependency", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(["tldts"]);
  });
});

describe("specification", () => {
  const spec = read("docs/specs/2026-11-21-thunderbird-block-spam-design.md");

  it("ships the default prompt of the specification, character for character", () => {
    const match = /Default prompt:\n\n```\n([\s\S]*?)\n```/.exec(spec);
    expect(match?.[1]).toBe(DEFAULT_PROMPT);
  });

  it("uses the fixed output line of the specification", async () => {
    const { OUTPUT_LINE } = await import("../src/core/score");
    const match = /appends one fixed output line to the prompt:\n\n```\n([\s\S]*?)\n```/.exec(spec);
    expect(match?.[1]).toBe(OUTPUT_LINE);
  });
});

describe("XPI writer", () => {
  it("computes CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it("writes an archive that can be read back, sorted and with a fixed date", () => {
    const files = [
      { name: "b/second.txt", data: Buffer.from("second ".repeat(100)) },
      { name: "a.txt", data: Buffer.from("x") },
    ];
    const archive: Buffer = createZip(files);
    expect(createZip([...files].reverse()).equals(archive)).toBe(true);

    const end = archive.length - 22;
    expect(archive.readUInt32LE(end)).toBe(0x06054b50);
    expect(archive.readUInt16LE(end + 10)).toBe(2);
    let offset = archive.readUInt32LE(end + 16);
    const names: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
      const method = archive.readUInt16LE(offset + 10);
      const compressed = archive.readUInt32LE(offset + 20);
      const size = archive.readUInt32LE(offset + 24);
      const nameLength = archive.readUInt16LE(offset + 28);
      const local = archive.readUInt32LE(offset + 42);
      const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      names.push(name);
      const dataStart = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      const body = archive.subarray(dataStart, dataStart + compressed);
      const data = method === 8 ? inflateRawSync(body) : body;
      const original = files.find((file) => file.name === name)?.data;
      expect(data.length).toBe(size);
      expect(original !== undefined && data.equals(original)).toBe(true);
      expect(crc32(data)).toBe(archive.readUInt32LE(offset + 16));
      offset += 46 + nameLength;
    }
    expect(names).toEqual(["a.txt", "b/second.txt"]);
  });
});
