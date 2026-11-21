// AI: access points (add from a preset, edit, remove, reorder, enable, test), the
// ChatGPT plan sign-in, the prompt editor and the cutoff.

import { USAGE_URL } from "../../ai/chatgptAuth";
import { originPattern, validateEndpoint } from "../../ai/http";
import { checkDefinition, FIXED_ENDPOINTS, normalizeDefinition, PRESETS } from "../../ai/presets";
import type { AccessPointDefinition, Preset } from "../../ai/presets";
import type { ModelOption } from "../../ai/openaiChat";
import { OUTPUT_LINE } from "../../core/score";
import { DEFAULT_PROMPT } from "../../core/settings";
import type { AccessPoint } from "../../core/types";
import { t, tCode } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { button, byId, dialog, formatScore, formatTime, guard, h, option, replace, toast } from "../dom";
import { LOOPBACK_ORIGIN, requestAccess } from "../permissions";
import type { Model } from "../model";
import type { Section } from "../section";

const CHATGPT_ORIGINS = ["https://auth.openai.com/*", "https://api.openai.com/*"];

function hostOf(endpoint: string): string {
  const checked = validateEndpoint(endpoint);
  return checked.ok ? checked.url.host : endpoint;
}

function patternOf(endpoint: string): string | null {
  const checked = validateEndpoint(endpoint);
  return checked.ok ? originPattern(checked.url) : null;
}

function definitionOf(point: AccessPoint, changes: Partial<AccessPointDefinition> = {}): AccessPointDefinition {
  return { type: point.type, name: point.name, enabled: point.enabled, endpoint: point.endpoint, model: point.model, ...changes };
}

export function aiSection(startPolling: () => void): Section {
  const root = byId("ai");
  let model: Model | null = null;
  /** Results of the Test button, kept across redraws. */
  const testResults = new Map<string, { text: string; ok: boolean }>();
  const modelLists = new Map<string, ModelOption[]>();
  let editing: { id: string | null; preset: Preset | null } | null = null;
  let welcomeOpen = false;
  let signInDrawn = "";
  /** The field for the pasted redirect address. It keeps its text while the panel is redrawn. */
  const pasted = h("input", { type: "text", placeholder: "http://127.0.0.1:1455/auth/callback?code=..." });
  let pastedFor: string | null = null;

  const list = h("div", { class: "access-points" });
  const presetSelect = h("select", {}, ...PRESETS.map((preset) => option(preset.id, tCode("preset", preset.id))));
  const editor = h("div", { class: "editor" });
  const signInPanel = h("div", { class: "sign-in" });
  const prompt = h("textarea", { rows: 14, id: "prompt" });
  let promptSaved = "";
  const cutoff = h("input", { type: "number", id: "cutoff", min: "0", max: "1", step: "0.01" });

  replace(
    root,
    h("h2", { text: t("sectionAi") }),
    h("p", { class: "hint", text: t("aiHint") }),
    h("p", { class: "hint", text: t("aiSecretsHint") }),
    h("h3", { text: t("accessPointsTitle") }),
    h("p", { class: "hint", text: t("accessPointsHint") }),
    list,
    h(
      "div",
      { class: "row" },
      presetSelect,
      button(
        t("accessPointAdd"),
        () => {
          const preset = PRESETS.find((item) => item.id === presetSelect.value) ?? null;
          if (preset?.type === "chatgpt") {
            startChatGpt(null);
          } else if (preset !== null) {
            editing = { id: null, preset };
            drawEditor();
          }
        },
        "primary",
      ),
    ),
    editor,
    signInPanel,
    h("p", { class: "hint", text: t("localServerHint", location.origin) }),
    h("h3", { text: t("promptTitle") }),
    h("p", { class: "hint", text: t("promptHint") }),
    prompt,
    h("p", { class: "hint", text: t("outputLineLabel") }),
    h("pre", { class: "output-line", text: OUTPUT_LINE }),
    h(
      "div",
      { class: "row" },
      button(t("promptSave"), () => void savePrompt(prompt.value), "primary"),
      button(t("promptRestore"), () => {
        prompt.value = DEFAULT_PROMPT;
        void savePrompt(DEFAULT_PROMPT);
      }),
    ),
    h("h3", { text: t("cutoffTitle") }),
    h(
      "div",
      { class: "row" },
      h("label", { for: "cutoff", text: t("cutoffLabel") }),
      cutoff,
      button(t("save"), () =>
        void guard(async () => {
          const value = Number(cutoff.value);
          if (cutoff.value.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) {
            toast(t("cutoffInvalid"), "error");
            return;
          }
          await send("updateSettings", { patch: { cutoff: value } });
          toast(t("saved"));
        }),
      ),
    ),
    h("p", { class: "hint", text: t("cutoffHint") }),
  );

  async function savePrompt(text: string): Promise<void> {
    if (text.trim() === "") {
      toast(t("promptEmpty"), "error");
      return;
    }
    await guard(async () => {
      await send("updateSettings", { patch: { prompt: text } });
      promptSaved = text;
      toast(t("saved"));
    });
  }

  /** Explains what is sent and asks for consent before sign-in. The terms of the programme require it. */
  function startChatGpt(accessPointId: string | null): void {
    void dialog({
      title: t("chatgptConsentTitle"),
      body: [t("chatgptConsentText"), t("consentWhat"), t("consentNever"), t("chatgptConsentManage")],
      confirmLabel: t("chatgptContinue"),
      onConfirm: async () => {
        // webRequest on the loopback address lets the add-on read the sign-in redirect.
        // Where Thunderbird does not offer it, the user pastes the address by hand.
        const granted = await requestAccess([...CHATGPT_ORIGINS, LOOPBACK_ORIGIN], ["webRequest"]);
        if (!granted) {
          toast(t("permissionDeclined"), "error");
          return false;
        }
        await send("startSignIn", { accessPointId, openTab: true });
        startPolling();
        return true;
      },
    });
  }

  function drawSignIn(): void {
    const signIn = model?.status.signIn;
    // Redraw only when something changed, so a pasted address is not wiped while typing.
    const signature = JSON.stringify(signIn ?? null);
    if (signature === signInDrawn) {
      return;
    }
    signInDrawn = signature;
    if (signIn === undefined || (signIn.url === null && signIn.error === "")) {
      replace(signInPanel);
      return;
    }
    if (signIn.url === null) {
      replace(signInPanel, h("p", { class: "warning", text: t("signInFailed", signIn.error) }));
      return;
    }
    const url = signIn.url;
    if (url !== pastedFor) {
      pastedFor = url;
      pasted.value = "";
    }
    replace(
      signInPanel,
      h("h4", { text: t("signInTitle") }),
      h("p", { text: t(signIn.capture ? "signInWaiting" : "signInManual") }),
      h(
        "div",
        { class: "row" },
        button(t("signInOpenBrowser"), () => void guard(() => browser.windows.openDefaultBrowser(url))),
        button(t("signInCopy"), () =>
          void guard(async () => {
            await navigator.clipboard.writeText(url);
            toast(t("copied"));
          }),
        ),
      ),
      h("p", { class: "hint", text: t("signInPasteHint") }),
      h(
        "div",
        { class: "row" },
        pasted,
        button(
          t("signInFinish"),
          () =>
            void guard(async () => {
              await send("finishSignIn", { url: pasted.value });
              toast(t("signInDone"));
            }),
          "primary",
        ),
        button(t("cancel"), () => void guard(() => send("cancelSignIn", {}))),
      ),
      signIn.error === "" ? null : h("p", { class: "warning", text: t("signInFailed", signIn.error) }),
    );
  }

  function drawEditor(): void {
    if (editing === null || model === null) {
      replace(editor);
      return;
    }
    const existing = editing.id === null ? null : (model.accessPoints.find((point) => point.id === editing?.id) ?? null);
    const preset = editing.preset;
    const type = existing?.type ?? preset?.type;
    if (type === undefined || (editing.id !== null && existing === null)) {
      editing = null;
      replace(editor);
      return;
    }
    const fixed = FIXED_ENDPOINTS[type] !== undefined;
    const presetName = preset === null ? "" : tCode("preset", preset.id);
    const name = h("input", { type: "text", value: existing?.name ?? presetName });
    const endpoint = h("input", { type: "url", value: existing?.endpoint ?? preset?.endpoint ?? "", disabled: fixed });
    const modelInput = h("input", { type: "text", value: existing?.model ?? preset?.model ?? "" });
    const models = h("datalist", { id: "model-options" });
    modelInput.setAttribute("list", "model-options");
    const key = h("input", {
      type: "password",
      placeholder: existing !== null && existing.apiKey !== "" ? t("keyKeep") : t("keyPlaceholder"),
    });
    key.autocomplete = "off";
    const problemsBox = h("p", { class: "warning" });

    const save = (): void => {
      const definition = normalizeDefinition({
        type,
        name: name.value,
        enabled: existing?.enabled ?? true,
        endpoint: endpoint.value,
        model: modelInput.value,
      });
      const newKey = key.value.trim() === "" ? null : key.value.trim();
      const problems = checkDefinition(definition, newKey !== null || (existing !== null && existing.apiKey !== ""));
      if (problems.length > 0) {
        problemsBox.textContent = problems.map((problem) => tCode("problem", problem)).join(" ");
        return;
      }
      problemsBox.textContent = "";
      const request = { id: existing?.id ?? null, definition, apiKey: newKey };
      const finish = async (): Promise<void> => {
        await send("saveAccessPoint", request);
        editing = null;
        drawEditor();
        toast(t("saved"));
      };
      const pattern = patternOf(definition.endpoint);
      if (pattern === null) {
        void guard(finish);
        return;
      }
      if (existing !== null && patternOf(existing.endpoint) === pattern) {
        // A known host. The permission is asked for again without a dialog, because
        // an imported access point never had it on this computer. Thunderbird shows
        // no prompt when it is already granted.
        void guard(async () => {
          if (!(await requestAccess([pattern]))) {
            toast(t("permissionDeclined"), "error");
            return;
          }
          await finish();
        });
        return;
      }
      // A new host: explain what will be sent there and ask for the host permission.
      void dialog({
        title: t("consentTitle"),
        body: [t("consentText", hostOf(definition.endpoint)), t("consentWhat"), t("consentNever")],
        confirmLabel: t("consentAgree"),
        onConfirm: async () => {
          if (!(await requestAccess([pattern]))) {
            toast(t("permissionDeclined"), "error");
            return false;
          }
          await finish();
          return true;
        },
      });
    };

    const field = (label: string, control: HTMLElement, hint = ""): HTMLElement =>
      h("label", { class: "field" }, h("span", { text: label }), control, hint === "" ? null : h("small", { text: hint }));

    replace(
      editor,
      h("h4", { text: existing === null ? t("editorAddTitle", presetName) : t("editorEditTitle", existing.name) }),
      field(t("fieldName"), name),
      type === "chatgpt" ? null : field(t("fieldEndpoint"), endpoint, fixed ? t("endpointFixed") : tCode("endpointHint", type)),
      field(t("fieldModel"), modelInput, tCode("modelHint", type)),
      models,
      type === "chatgpt" ? null : field(t("fieldKey"), key, t("keyHint")),
      problemsBox,
      h(
        "div",
        { class: "row" },
        button(t("save"), save, "primary"),
        existing !== null && (type === "openai-chat" || type === "chatgpt")
          ? button(t("loadModels"), () =>
              void guard(async () => {
                const options = await send("listModels", { id: existing.id });
                replace(models, ...options.map((item) => option(item.id, item.label)));
                toast(options.length === 0 ? t("loadModelsNone") : t("loadModelsDone", options.length));
              }),
            )
          : null,
        button(t("cancel"), () => {
          editing = null;
          drawEditor();
        }),
      ),
    );
    name.focus();
  }

  function statusLine(point: AccessPoint, now: number): HTMLElement {
    const parts: (HTMLElement | string)[] = [];
    if (!point.enabled) {
      parts.push(h("span", { class: "badge off", text: t("apDisabled") }));
    }
    if (point.needsAttention) {
      parts.push(h("span", { class: "badge black", text: t("apNeedsAttention") }));
    }
    if (point.cooldownUntil > now) {
      parts.push(h("span", { class: "badge paused", text: t("apCoolingDown", formatTime(point.cooldownUntil)) }));
    }
    if (point.lastError !== "") {
      parts.push(h("span", { class: "error-text", text: t("apLastError", point.lastError) }));
    }
    return h("div", { class: "ap-status" }, ...parts);
  }

  function drawRow(point: AccessPoint, index: number, count: number): HTMLElement {
    const now = Date.now();
    const signedIn = point.type === "chatgpt" && point.auth !== null && point.auth.refreshToken !== "";
    const result = testResults.get(point.id);
    const enabled = h("input", {
      type: "checkbox",
      checked: point.enabled,
      title: t("apEnabled"),
      onchange: () => void guard(() => send("saveAccessPoint", { id: point.id, definition: definitionOf(point, { enabled: enabled.checked }), apiKey: null })),
    });
    const test = button(t("apTest"), () => {
      test.disabled = true;
      testResults.set(point.id, { text: t("apTesting"), ok: true });
      drawList();
      void (async () => {
        try {
          const outcome = await send("testAccessPoint", { id: point.id });
          testResults.set(
            point.id,
            outcome.ok ? { text: t("apTestScore", formatScore(outcome.score)), ok: true } : { text: t("apTestFailed", outcome.error), ok: false },
          );
        } catch (error) {
          testResults.set(point.id, { text: t("apTestFailed", error instanceof Error ? error.message : String(error)), ok: false });
        }
        drawList();
      })();
    });

    const chatgpt: (HTMLElement | null)[] = [];
    if (point.type === "chatgpt") {
      const options = modelLists.get(point.id);
      const select =
        options === undefined
          ? null
          : h(
              "select",
              {
                onchange: () =>
                  void guard(() => send("saveAccessPoint", { id: point.id, definition: definitionOf(point, { model: select?.value ?? point.model }), apiKey: null })),
              },
              ...(options.some((item) => item.id === point.model) || point.model === "" ? [] : [option(point.model, point.model, true)]),
              ...options.map((item) => option(item.id, item.label, item.id === point.model)),
            );
      chatgpt.push(
        h(
          "div",
          { class: "row" },
          h("span", { class: "badge plan", text: signedIn ? t("chatgptUsingPlan") : t("chatgptSignedOut") }),
          signedIn ? h("span", { text: point.auth?.email ?? "" }) : null,
          signedIn ? button(t("chatgptManageUsage"), () => void guard(() => browser.windows.openDefaultBrowser(USAGE_URL)), "link") : null,
        ),
        h(
          "div",
          { class: "row" },
          select,
          signedIn
            ? button(t("chatgptChooseModel"), () =>
                void guard(async () => {
                  modelLists.set(point.id, await send("listModels", { id: point.id }));
                  drawList();
                }),
              )
            : null,
          button(t(signedIn ? "chatgptSignInAgain" : "chatgptContinue"), () => startChatGpt(point.id), signedIn ? "" : "primary"),
          signedIn
            ? button(t("chatgptSignOut"), () =>
                void guard(async () => {
                  const { revocationConfirmed } = await send("signOut", { id: point.id });
                  toast(t(revocationConfirmed ? "chatgptSignedOutDone" : "chatgptRevocationUnconfirmed"), revocationConfirmed ? "info" : "error");
                }),
              )
            : null,
        ),
      );
    }

    return h(
      "div",
      { class: `access-point${point.enabled ? "" : " disabled"}` },
      h(
        "div",
        { class: "ap-head" },
        h("span", { class: "ap-order", text: String(index + 1) }),
        enabled,
        h("strong", { text: point.name }),
        h("span", { class: "ap-type", text: tCode("type", point.type) }),
        h("span", { class: "ap-model", text: point.model === "" ? t("apNoModel") : point.model }),
      ),
      point.type === "chatgpt" ? null : h("div", { class: "ap-endpoint", text: point.endpoint }),
      statusLine(point, now),
      ...chatgpt,
      h(
        "div",
        { class: "row" },
        index === 0 ? null : button("↑", () => void guard(() => send("moveAccessPoint", { id: point.id, direction: -1 })), "small"),
        index === count - 1 ? null : button("↓", () => void guard(() => send("moveAccessPoint", { id: point.id, direction: 1 })), "small"),
        test,
        button(t("edit"), () => {
          editing = { id: point.id, preset: null };
          drawEditor();
        }),
        button(
          t("remove"),
          () =>
            void dialog({
              title: t("apRemoveTitle", point.name),
              body: [t("apRemoveText")],
              confirmLabel: t("remove"),
              danger: true,
              onConfirm: async () => {
                const { revocationConfirmed } = await send("removeAccessPoint", { id: point.id });
                if (!revocationConfirmed) {
                  toast(t("chatgptRevocationUnconfirmed"), "error");
                }
              },
            }),
          "danger",
        ),
        result === undefined ? null : h("span", { class: result.ok ? "test-ok" : "error-text", text: result.text }),
      ),
    );
  }

  function drawList(): void {
    if (model === null) {
      return;
    }
    const points = model.accessPoints;
    replace(
      list,
      points.length === 0 ? h("p", { class: "hint", text: t("accessPointsNone") }) : null,
      ...points.map((point, index) => drawRow(point, index, points.length)),
    );
  }

  function maybeWelcome(): void {
    const settings = model?.settings;
    if (settings === null || settings === undefined || settings.chatgptWelcomeShown || welcomeOpen) {
      return;
    }
    const usingPlan = model?.accessPoints.some((point) => point.type === "chatgpt" && point.auth !== null && point.auth.refreshToken !== "");
    if (usingPlan !== true) {
      return;
    }
    // Shown once, after the first sign-in with ChatGPT plan use.
    welcomeOpen = true;
    void dialog({
      title: t("chatgptWelcomeTitle"),
      body: [
        t("chatgptWelcomeText"),
        button(t("chatgptManageUsage"), () => void guard(() => browser.windows.openDefaultBrowser(USAGE_URL)), "link"),
      ],
      confirmLabel: t("chatgptWelcomeGotIt"),
      hideCancel: true,
    }).then(async () => {
      welcomeOpen = false;
      await guard(() => send("welcomeShown", {}));
    });
  }

  return {
    render(next: Model) {
      model = next;
      const settings = next.settings;
      if (settings === null) {
        return;
      }
      drawList();
      drawSignIn();
      if (editing?.id !== null && editing !== null && !next.accessPoints.some((point) => point.id === editing?.id)) {
        editing = null;
        drawEditor();
      }
      // Never overwrite text the user is typing.
      if (prompt.value === promptSaved) {
        prompt.value = settings.prompt;
      }
      promptSaved = settings.prompt;
      if (document.activeElement !== cutoff) {
        cutoff.value = settings.cutoff.toFixed(2);
      }
      maybeWelcome();
    },
  };
}
