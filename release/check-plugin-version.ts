import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { z } from "zod";

const manifest = z.looseObject({
  name: z.literal("codex-app-server"),
  version: z.unknown()
});
const marketplace = z
  .object({ plugins: z.tuple([manifest]) })
  .transform(({ plugins: [plugin] }) => plugin);

/**
 * Validate calendar release versions and require the same version in every file.
 */
export const validatePluginVersions = (
  versions: Readonly<Record<string, unknown>>
) => {
  for (const [file, version] of Object.entries(versions)) {
    const match =
      typeof version === "string"
        ? /^(?<year>\d{4})\.(?<month>\d{2})\.(?<day>\d{2})-[1-9]\d*$/u.exec(
            version
          )
        : null;
    if (!match?.groups) {
      throw new Error(`${file} plugin version must use yyyy.MM.dd-seq format.`);
    }
    const year = Number(match.groups.year);
    const month = Number(match.groups.month);
    const day = Number(match.groups.day);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    if (
      year === 0 ||
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new Error(`${file} plugin version must contain a valid date.`);
    }
  }
  if (new Set(Object.values(versions)).size !== 1) {
    throw new Error(
      "Host manifest and marketplace plugin versions must match."
    );
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    validatePluginVersions(
      Object.fromEntries(
        Object.entries({
          ".claude-plugin/plugin.json": manifest,
          ".codex-plugin/plugin.json": manifest,
          ".claude-plugin/marketplace.json": marketplace,
          ".agents/plugins/marketplace.json": marketplace
        }).map(([file, schema]) => [
          file,
          schema.parse(
            JSON.parse(
              readFileSync(new URL(`../${file}`, import.meta.url), "utf-8")
            )
          ).version
        ])
      )
    );
    process.stdout.write(
      "Host manifest and marketplace plugin versions match the yyyy.MM.dd-seq format.\n"
    );
  } catch (error) {
    process.stderr.write(
      `Plugin version validation failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
