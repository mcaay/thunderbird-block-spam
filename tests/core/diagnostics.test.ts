// The diagnostics of failed AI requests: what the add-on wrote is told apart from what it quotes.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_CODES,
  DIAGNOSTICS,
  httpDiagnostic,
  networkDiagnostic,
  parseAttempts,
  parseDiagnostic,
  permissionDiagnostic,
  renewDiagnostic,
  serviceDiagnostic,
  timeoutDiagnostic,
  usageLimitDiagnostic,
} from "../../src/core/diagnostics";

describe("diagnostics", () => {
  it("takes an HTTP error apart into the status and the service's own message", () => {
    expect(parseDiagnostic(httpDiagnostic(401, "Incorrect API key provided"))).toEqual({
      code: "http",
      args: ["401"],
      detail: "Incorrect API key provided",
      from: "service",
    });
    expect(parseDiagnostic(httpDiagnostic(500, ""))).toEqual({ code: "http", args: ["500"], detail: "", from: "service" });
  });

  it("knows every diagnostic the add-on writes", () => {
    for (const text of Object.values(DIAGNOSTICS)) {
      expect(parseDiagnostic(text), text).not.toBeNull();
    }
    expect(parseDiagnostic(timeoutDiagnostic(30))).toMatchObject({ code: "timeout", args: ["30"], detail: "" });
    expect(parseDiagnostic(networkDiagnostic("NetworkError when attempting to fetch resource."))).toEqual({
      code: "network",
      args: [],
      detail: "NetworkError when attempting to fetch resource.",
      from: "platform",
    });
    expect(parseDiagnostic(usageLimitDiagnostic("try again later"))).toMatchObject({ code: "usage-limit", detail: "try again later" });
    expect(parseDiagnostic(permissionDiagnostic("https://api.example.com/*"))).toMatchObject({ code: "no-permission", args: ["https://api.example.com/*"] });
    expect(parseDiagnostic(serviceDiagnostic("This plan cannot be used."))).toMatchObject({ code: "service", detail: "This plan cannot be used." });
  });

  it("does not quote its own words as the service's", () => {
    expect(parseDiagnostic(renewDiagnostic("invalid_grant: Token expired"))).toMatchObject({ code: "renew-failed", detail: "invalid_grant: Token expired" });
    expect(parseDiagnostic(renewDiagnostic(httpDiagnostic(500, "")))).toMatchObject({ code: "renew-failed", detail: "" });
    expect(parseDiagnostic(renewDiagnostic("unexpected answer"))).toMatchObject({ code: "renew-failed", detail: "" });
  });

  it("leaves any other text alone", () => {
    expect(parseDiagnostic("socket hang up")).toBeNull();
    expect(parseDiagnostic("")).toBeNull();
    expect(parseDiagnostic("HTTP 4")).toBeNull();
  });

  it("uses only codes the pages can say", () => {
    const codes = new Set<string>(DIAGNOSTIC_CODES);
    for (const text of [...Object.values(DIAGNOSTICS), httpDiagnostic(500, ""), timeoutDiagnostic(1), networkDiagnostic("x"), usageLimitDiagnostic("x"), renewDiagnostic("x"), permissionDiagnostic("x"), serviceDiagnostic("x")]) {
      expect(codes.has(parseDiagnostic(text)?.code ?? ""), text).toBe(true);
    }
  });

  it("takes the attempts of a decision without a verdict apart", () => {
    expect(parseAttempts("Jev: HTTP 500: Mock HTTP 500; OpenAI: HTTP 429")).toEqual([
      { accessPoint: "Jev", error: "HTTP 500: Mock HTTP 500" },
      { accessPoint: "OpenAI", error: "HTTP 429" },
    ]);
    // A message of a service may contain the separator itself.
    expect(parseAttempts("Jev: HTTP 400: bad input; try again")).toEqual([{ accessPoint: "Jev", error: "HTTP 400: bad input; try again" }]);
    expect(parseAttempts("leadgen.example [all]")).toBeNull();
    expect(parseAttempts("")).toBeNull();
  });

  it("is the only place where the text of a failure is written", () => {
    const root = path.resolve(import.meta.dirname, "../../src");
    const files = ["ai", "core"].flatMap((directory) => readdirSync(path.join(root, directory)).map((name) => path.join(directory, name)));
    for (const file of files.filter((name) => name.endsWith(".ts") && !name.endsWith("diagnostics.ts"))) {
      // A failure is created with a diagnostic of this module, or passes on the message of another failure.
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toMatch(/new AccessPointError\(\s*[^,]+,\s*["`]/);
    }
  });
});
