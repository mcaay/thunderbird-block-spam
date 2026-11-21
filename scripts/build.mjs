// Builds both add-ons into dist/:
//   dist/companion/                    the unpacked companion add-on
//   dist/block-spam-keys-<version>.xpi the optional bare-key companion
//   dist/main/                         the unpacked main add-on, with the packed companion in companion/
//   dist/block-spam-<version>.xpi      the main add-on
//
// Usage: npm run build

import { build } from "esbuild";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

async function filesUnder(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.name === ".DS_Store") {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(full, base)));
    } else {
      files.push({ name: path.relative(base, full).split(path.sep).join("/"), data: await readFile(full) });
    }
  }
  return files;
}

async function writeManifest(source, target) {
  const manifest = JSON.parse(await readFile(source, "utf8"));
  manifest.version = version;
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function pack(directory, name) {
  const archive = createZip(await filesUnder(directory));
  const target = path.join(dist, name);
  await writeFile(target, archive);
  console.log(`${path.relative(root, target)}  ${archive.length} bytes`);
}

await rm(dist, { recursive: true, force: true });

// Companion add-on first: plain files, no bundling. Its packed file is also shipped
// inside the main add-on, which offers it for saving (it never loads or installs it).
const companion = path.join(dist, "companion");
const companionFile = `block-spam-keys-${version}.xpi`;
await cp(path.join(root, "companion"), companion, {
  recursive: true,
  filter: (source) => !source.endsWith(".md") && !source.endsWith(".DS_Store"),
});
await writeManifest(path.join(root, "companion/manifest.json"), path.join(companion, "manifest.json"));
await cp(path.join(root, "LICENSE"), path.join(companion, "LICENSE"));
await pack(companion, companionFile);

// Main add-on.
const main = path.join(dist, "main");
await mkdir(main, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: {
    background: "src/background.ts",
    "options/options": "src/options/options.ts",
    "popup/popup": "src/popup/popup.ts",
  },
  outdir: main,
  bundle: true,
  format: "iife",
  target: "firefox140",
  charset: "utf8",
  legalComments: "inline",
  logLevel: "warning",
});
await writeManifest(path.join(root, "src/manifest.json"), path.join(main, "manifest.json"));
await cp(path.join(root, "src/_locales"), path.join(main, "_locales"), { recursive: true });
await cp(path.join(root, "src/icons"), path.join(main, "icons"), { recursive: true });
for (const file of ["common.css", "options/options.html", "options/options.css", "popup/popup.html", "popup/popup.css"]) {
  await cp(path.join(root, "src", file), path.join(main, file));
}
for (const file of ["LICENSE", "THIRD_PARTY_LICENSES.md"]) {
  await cp(path.join(root, file), path.join(main, file));
}
// The settings page saves this file to the user's computer on request, see "Block and trust".
await mkdir(path.join(main, "companion"), { recursive: true });
await cp(path.join(dist, companionFile), path.join(main, "companion", companionFile));
await pack(main, `block-spam-${version}.xpi`);
