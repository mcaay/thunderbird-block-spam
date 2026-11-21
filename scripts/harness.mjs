// Builds a browser harness in dist/harness: the built background page and the built
// settings page (or popup) running together in one ordinary browser window, against
// a fake of the Thunderbird API with in-memory accounts and mail.
//
// It is a development aid for trying the user interface without Thunderbird. It
// proves nothing about a real Thunderbird: see docs/manual-test-checklist.md.
//
// Usage:
//   npm run harness
//   python3 -m http.server 8765 --bind 127.0.0.1 --directory dist/harness
//   open http://localhost:8765/options/options.html (or /popup/popup.html)
//
// The page must be served from localhost, because the code needs a secure context.

import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const main = path.join(root, "dist/main");
const out = path.join(root, "dist/harness");

await rm(out, { recursive: true, force: true });
await cp(main, out, { recursive: true });
await cp(path.join(root, "scripts/harness/fake-browser.js"), path.join(out, "fake-browser.js"));

const messages = await readFile(path.join(main, "_locales/en/messages.json"), "utf8");
await writeFile(path.join(out, "messages.js"), `window.__HARNESS_MESSAGES = ${messages};\n`);

// The fake API and the background page load before the page's own script.
for (const [file, script] of [
  ["options/options.html", "options.js"],
  ["popup/popup.html", "popup.js"],
]) {
  const target = path.join(out, file);
  const tag = `<script src="${script}"></script>`;
  const html = await readFile(target, "utf8");
  if (!html.includes(tag)) {
    throw new Error(`${file}: the script tag was not found`);
  }
  const scripts = ["../messages.js", "../fake-browser.js", "../background.js", script];
  await writeFile(target, html.replace(tag, scripts.map((source) => `<script src="${source}"></script>`).join("\n    ")));
}
console.log(`harness written to ${path.relative(root, out)}`);
