import { beforeEach, describe, expect, it } from "vitest";
import {
  DATA_COLLECTION,
  detectPermissionSupport,
  LOOPBACK_ORIGIN,
  permissionSupport,
  requestAccess,
  resetPermissionSupport,
} from "../../src/options/permissions";

interface Request {
  origins?: string[];
  permissions?: string[];
  data_collection?: string[];
}

type Behaviour = (request: Request) => Promise<boolean>;

let requests: Request[] = [];
let behaviour: Behaviour = async () => true;
let granted: Request = { data_collection: [] };
let optional: string[] | undefined = ["accountsFolders", "webRequest"];

function installFakeBrowser(): void {
  (globalThis as unknown as { browser: unknown }).browser = {
    permissions: {
      request: (request: Request) => {
        requests.push(request);
        return behaviour(request);
      },
      getAll: async () => granted,
    },
    runtime: { getManifest: () => ({ version: "1.0.0", name: "Block Spam", optional_permissions: optional }) },
    i18n: { getMessage: (name: string) => name },
  };
}

const OPENAI = ["https://auth.openai.com/*", "https://api.openai.com/*"];

beforeEach(() => {
  requests = [];
  behaviour = async () => true;
  granted = { data_collection: [] };
  optional = ["accountsFolders", "webRequest"];
  installFakeBrowser();
  resetPermissionSupport();
});

describe("permission support detection", () => {
  it("assumes no data collection support until it was detected", () => {
    expect(permissionSupport()).toEqual({ dataCollection: false, webRequest: true });
  });

  it("detects data collection permissions and the optional webRequest permission", async () => {
    await detectPermissionSupport();
    expect(permissionSupport()).toEqual({ dataCollection: true, webRequest: true });
  });

  it("detects a Thunderbird without them", async () => {
    granted = { origins: [], permissions: [] };
    optional = ["accountsFolders"];
    await detectPermissionSupport();
    expect(permissionSupport()).toEqual({ dataCollection: false, webRequest: false });
  });
});

describe("requestAccess", () => {
  it("asks synchronously, so the click is still being handled", () => {
    void requestAccess(["https://api.example.com/*"]);
    expect(requests).toHaveLength(1);
  });

  it("asks for the host and the data collection permission together", async () => {
    await detectPermissionSupport();
    expect(await requestAccess(["https://api.example.com/*"])).toBe(true);
    expect(requests).toEqual([{ origins: ["https://api.example.com/*"], permissions: [], data_collection: [...DATA_COLLECTION] }]);
  });

  it("keeps a loopback host of an ordinary access point", async () => {
    await requestAccess([LOOPBACK_ORIGIN]);
    expect(requests[0]?.origins).toEqual([LOOPBACK_ORIGIN]);
  });

  it("reports a declined request", async () => {
    behaviour = async () => false;
    expect(await requestAccess(["https://api.example.com/*"])).toBe(false);
  });

  it("asks for webRequest and the loopback address for the ChatGPT sign-in", async () => {
    await detectPermissionSupport();
    await requestAccess([...OPENAI, LOOPBACK_ORIGIN], ["webRequest"]);
    expect(requests).toEqual([{ origins: [...OPENAI, LOOPBACK_ORIGIN], permissions: ["webRequest"], data_collection: [...DATA_COLLECTION] }]);
  });

  it("leaves webRequest and the loopback address out where Thunderbird does not offer it", async () => {
    optional = ["accountsFolders"];
    await detectPermissionSupport();
    await requestAccess([...OPENAI, LOOPBACK_ORIGIN], ["webRequest"]);
    expect(requests).toEqual([{ origins: OPENAI, permissions: [], data_collection: [...DATA_COLLECTION] }]);
  });

  it("tries the next form at once when a form is refused synchronously", async () => {
    await detectPermissionSupport();
    behaviour = (request) => {
      if (request.data_collection !== undefined) {
        throw new Error("Unexpected property data_collection");
      }
      if (request.permissions?.includes("webRequest")) {
        throw new Error("Invalid enumeration value webRequest");
      }
      return Promise.resolve(true);
    };
    const result = requestAccess([...OPENAI, LOOPBACK_ORIGIN], ["webRequest"]);
    // All forms were tried before the first await.
    expect(requests).toHaveLength(4);
    expect(await result).toBe(true);
    expect(requests.at(-1)).toEqual({ origins: OPENAI, permissions: [] });
    expect(permissionSupport()).toEqual({ dataCollection: false, webRequest: false });

    requests = [];
    await requestAccess([...OPENAI, LOOPBACK_ORIGIN], ["webRequest"]);
    expect(requests).toHaveLength(1);
  });

  it("asks the user to press again when the data collection part is refused later", async () => {
    await detectPermissionSupport();
    behaviour = (request) =>
      request.data_collection === undefined ? Promise.resolve(true) : Promise.reject(new Error("not declared"));
    await expect(requestAccess(["https://api.example.com/*"])).rejects.toThrowError("permissionTryAgain");
    expect(permissionSupport().dataCollection).toBe(false);
    expect(await requestAccess(["https://api.example.com/*"])).toBe(true);
    expect(requests.at(-1)).toEqual({ origins: ["https://api.example.com/*"], permissions: [] });
  });

  it("then drops webRequest when that is refused later as well", async () => {
    behaviour = (request) =>
      request.permissions?.includes("webRequest") ? Promise.reject(new Error("not declared")) : Promise.resolve(true);
    await expect(requestAccess([...OPENAI, LOOPBACK_ORIGIN], ["webRequest"])).rejects.toThrowError("permissionTryAgain");
    expect(permissionSupport().webRequest).toBe(false);
    expect(await requestAccess([...OPENAI, LOOPBACK_ORIGIN], ["webRequest"])).toBe(true);
    expect(requests.at(-1)).toEqual({ origins: OPENAI, permissions: [] });
  });

  it("passes on the error of a plain request", async () => {
    behaviour = () => Promise.reject(new Error("may only be called from a user input handler"));
    await expect(requestAccess(["https://api.example.com/*"])).rejects.toThrowError("may only be called from a user input handler");
  });

  it("fails when every form is refused synchronously", async () => {
    behaviour = () => {
      throw new Error("refused");
    };
    await expect(requestAccess(["https://api.example.com/*"])).rejects.toThrowError("refused");
  });
});
