import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CORE_SCHEMA, load as yamlParser } from "js-yaml";
import { z } from "zod";

const metadataFile = new URL("workflow-action-defaults.yaml", import.meta.url);
const metadata = z
  .record(
    z.string(),
    z.object({
      commit: z.string(),
      inputs: z.record(
        z.string(),
        z.object({
          contextDependent: z.boolean().optional(),
          default: z.string().optional()
        })
      )
    })
  )
  .parse(yamlParser(readFileSync(metadataFile, "utf-8")));
const workflow = z.object({
  jobs: z.record(
    z.string(),
    z.object({ steps: z.array(z.unknown()).optional() })
  )
});
const actionStep = z.object({
  uses: z.string(),
  with: z.record(z.string(), z.unknown())
});

/**
 * @param {unknown} step - Parsed workflow step.
 * @param {string} location - Workflow path and step for diagnostics.
 */
const validateStep = (step, location) => {
  const parsed = actionStep.safeParse(step);
  if (!parsed.success || !Object.hasOwn(metadata, parsed.data.uses)) {
    return [];
  }
  const { uses, with: inputs } = parsed.data;
  return Object.entries(inputs).flatMap(([name, value]) => {
    const approved = metadata[uses].inputs[name];
    const literal =
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number"
        ? String(value)
        : null;
    return literal !== null &&
      !literal.includes("${{") &&
      approved?.contextDependent !== true &&
      literal === approved?.default
      ? [`${location}: omit ${name} for ${uses}. It equals the action default.`]
      : [];
  });
};

/**
 * Report literal action inputs that equal an approved default at the exact ref.
 * @param {string} content - Workflow YAML.
 * @param {string} source - Workflow path for diagnostics.
 */
export const validateWorkflowActionDefaults = (content, source) => {
  const parsed = workflow.safeParse(
    yamlParser(content, { filename: source, schema: CORE_SCHEMA })
  );
  return parsed.success
    ? Object.entries(parsed.data.jobs).flatMap(([job, { steps = [] }]) =>
        steps.flatMap((step, index) =>
          validateStep(step, `${source}: jobs.${job}.steps[${index + 1}]`)
        )
      )
    : [];
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = path.join(root, ".github/workflows");
  const errors = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .toSorted()
    .flatMap((file) =>
      validateWorkflowActionDefaults(
        readFileSync(file, "utf-8"),
        path.relative(root, file)
      )
    );
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}
