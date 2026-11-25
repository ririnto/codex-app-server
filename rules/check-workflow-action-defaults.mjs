import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  constructFromEvents,
  CORE_SCHEMA,
  eventsToAst,
  parseEvents,
  YAMLException
} from "js-yaml";
import { z } from "zod";

const metadataSchema = z.record(
  z.string(),
  z.object({
    commit: z.string(),
    inputs: z.record(
      z.string().toLowerCase(),
      z.object({
        contextDependent: z.boolean().optional(),
        default: z.string().optional()
      })
    )
  })
);
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
const root = fileURLToPath(new URL("../", import.meta.url));
const parseReasons = new Set([
  "bad indentation of a mapping entry",
  "bad indentation of a sequence entry",
  "duplicated mapping key",
  "missed comma between flow collection entries",
  "unexpected end of the stream within a flow collection",
  "unexpected end of the stream within a single quoted scalar",
  "unexpected end of the stream within a double quoted scalar"
]);

/**
 * @param {string} file - Repository-relative YAML path.
 */
const readYaml = (file) => {
  const source = readFileSync(path.join(root, file), "utf-8");
  let reason = "invalid YAML syntax";
  try {
    const events = parseEvents(source, {});
    reason = "invalid YAML value, tag, or alias";
    const documents = constructFromEvents(events, {
      schema: CORE_SCHEMA,
      source
    });
    if (documents.length !== 1) {
      return { error: `${file}:1:1: YAML-parse: expected one YAML document.` };
    }
    const syntax = events.some(
      (event) => "anchorStart" in event && event.anchorStart >= 0
    )
      ? (eventsToAst(events, { schema: CORE_SCHEMA, source })[0]?.contents ??
        null)
      : null;
    return { syntax, value: documents[0] };
  } catch (error) {
    const mark = error instanceof YAMLException ? error.mark : null;
    if (error instanceof YAMLException) {
      const { reason: parserReason } = error;
      if (parserReason.startsWith("unidentified alias")) {
        reason = "undefined YAML alias";
      } else if (parseReasons.has(parserReason)) {
        reason = parserReason;
      }
    }
    return {
      error: `${file}:${(mark?.line ?? 0) + 1}:${(mark?.column ?? 0) + 1}: YAML-parse: ${reason}.`
    };
  }
};

/**
 * @typedef {ReturnType<typeof eventsToAst>[number]["contents"]} YamlNode
 */

/**
 * @param {YamlNode} node - Unresolved workflow syntax.
 * @param {(number | string)[]} segments - Mapping keys and sequence indexes leading to the input.
 */
const findAnchor = (node, segments) => {
  let current = node;
  for (const segment of segments) {
    if (current?.anchor !== undefined) {
      return current.anchor;
    }
    if (current?.kind === "mapping") {
      const entry =
        current.items.find(
          ({ key }) => key.kind === "scalar" && key.value === segment
        ) ?? current.items.find(({ key }) => key.kind === "alias");
      if (entry?.key.anchor !== undefined) {
        return entry.key.anchor;
      }
      current = entry?.value ?? null;
    } else {
      current =
        current?.kind === "sequence" && typeof segment === "number"
          ? (current.items[segment] ?? null)
          : null;
    }
  }
  return current?.kind === "scalar" ? (current.anchor ?? null) : null;
};

/**
 * @param {unknown} step - Resolved workflow step.
 * @param {z.infer<typeof metadataSchema>} metadata - Approved inputs by exact action ref.
 * @param {YamlNode} syntax - Workflow syntax before alias resolution.
 * @param {string} source - Repository-relative workflow path.
 * @param {string} job - Workflow job identifier.
 * @param {number} index - Zero-based step position.
 */
const validateStep = (step, metadata, syntax, source, job, index) => {
  const parsed = actionStep.safeParse(step);
  if (!parsed.success || !Object.hasOwn(metadata, parsed.data.uses)) {
    return [];
  }
  const { uses, with: inputs } = parsed.data;
  const names = Map.groupBy(Object.keys(inputs), (name) => name.toLowerCase());
  return Object.entries(inputs).flatMap(([name, value]) => {
    const normalized = name.toLowerCase();
    const approved = metadata[uses].inputs[normalized];
    const literal =
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number"
        ? String(value)
        : null;
    if (
      literal !== null &&
      !literal.includes("${{") &&
      names.get(normalized)?.length === 1 &&
      approved?.contextDependent !== true &&
      literal === approved?.default
    ) {
      const location = `${source}: jobs.${job}.steps[${index + 1}]`;
      const anchor = findAnchor(syntax, [
        "jobs",
        job,
        "steps",
        index,
        "with",
        name
      ]);
      return anchor === null
        ? [
            `${location}: R35: omit ${name} for ${uses}. It equals the action default.`
          ]
        : [
            `${location}: R35-anchor: hand edit ${name} for ${uses} and preserve aliases for &${anchor}. The input equals the action default.`
          ];
    }
    return [];
  });
};

/**
 * @param {string} source - Repository-relative workflow path.
 * @param {z.infer<typeof metadataSchema>} metadata - Approved inputs by exact action ref.
 */
const validateWorkflowActionDefaults = (source, metadata) => {
  const document = readYaml(source);
  if (document.error !== undefined) {
    return [document.error];
  }
  const parsed = workflow.safeParse(document.value);
  return parsed.success
    ? Object.entries(parsed.data.jobs).flatMap(([job, { steps = [] }]) =>
        steps.flatMap((step, index) =>
          validateStep(step, metadata, document.syntax, source, job, index)
        )
      )
    : [];
};

const metadataFile = "rules/workflow-action-defaults.yaml";
const metadataDocument = readYaml(metadataFile);
const metadata = metadataSchema.safeParse(metadataDocument.value);
const directory = ".github/workflows";
const errors = metadata.success
  ? readdirSync(path.join(root, directory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .toSorted()
      .flatMap((file) => validateWorkflowActionDefaults(file, metadata.data))
  : [metadataDocument.error ?? `${metadataFile}: invalid action metadata.`];
if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
}
