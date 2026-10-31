import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

const manifest = z.looseObject({ version: z.unknown() });
const versionPattern =
  /^(?<year>\d{4})\.(?<month>\d{2})\.(?<day>\d{2})\.(?<sequence>\d{2})$/u;

/**
 * Validate matching host plugin versions in yyyy.mm.dd.seq format.
 * @param {unknown} claudeVersion - Claude host version from the manifest.
 * @param {unknown} codexVersion - Codex host version from the manifest.
 */
export const validatePluginVersions = (claudeVersion, codexVersion) => {
  /** @type {Array<[string, unknown]>} */
  const versions = [
    ["Claude", claudeVersion],
    ["Codex", codexVersion]
  ];
  for (const [host, version] of versions) {
    const match =
      typeof version === "string" ? versionPattern.exec(version) : null;
    if (!match?.groups) {
      throw new Error(`${host} plugin version must use yyyy.mm.dd.seq format.`);
    }
    const {
      year: yearText,
      month: monthText,
      day: dayText,
      sequence: sequenceText
    } = match.groups;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const sequence = Number(sequenceText);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    if (
      year === 0 ||
      sequence === 0 ||
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new Error(
        `${host} plugin version must contain a valid date and non-zero sequence.`
      );
    }
  }
  if (claudeVersion !== codexVersion) {
    throw new Error("Claude and Codex plugin versions must match.");
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    /** @type {unknown} */
    const claudeContent = JSON.parse(
      readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf-8")
    );
    /** @type {unknown} */
    const codexContent = JSON.parse(
      readFileSync(path.join(root, ".codex-plugin/plugin.json"), "utf-8")
    );
    const claude = manifest.parse(claudeContent);
    const codex = manifest.parse(codexContent);
    validatePluginVersions(claude.version, codex.version);
    process.stdout.write(
      "Host plugin versions match the yyyy.mm.dd.seq format.\n"
    );
  } catch (error) {
    process.stderr.write(
      `Plugin version validation failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
