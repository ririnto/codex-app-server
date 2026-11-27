import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = new URL("../", import.meta.url);
const outputRoot = new URL("dist/", sourceRoot);
const libraries = readdirSync(new URL("lib/", sourceRoot), {
  withFileTypes: true
});
const sources = [
  "server.ts",
  "monitor.ts",
  ...libraries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".d.ts")
    )
    .map(({ name }) => `lib/${name}`)
];
const manifest = { imports: { "#lib/*": "./lib/*.js" }, type: "module" };
const staging = mkdtempSync(
  fileURLToPath(new URL(".runtime-build-", sourceRoot))
);
try {
  mkdirSync(path.join(staging, "lib"));
  const outputs = ["package.json"];
  writeFileSync(
    path.join(staging, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  for (const filename of sources) {
    const source = readFileSync(new URL(filename, sourceRoot), "utf-8");
    const output = `${filename.slice(0, -3)}.js`;
    writeFileSync(path.join(staging, output), stripTypeScriptTypes(source));
    outputs.push(output);
  }
  mkdirSync(new URL("lib/", outputRoot), { recursive: true });
  for (const output of outputs) {
    renameSync(path.join(staging, output), new URL(output, outputRoot));
  }
} finally {
  rmSync(staging, { force: true, recursive: true });
}
