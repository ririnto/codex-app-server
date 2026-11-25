import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  constructFromEvents,
  CORE_SCHEMA,
  eventsToAst,
  parseEvents,
  visit,
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
const { values: options } = parseArgs({
  options: {
    help: { type: "boolean" },
    json: { type: "boolean" },
    workflows: { type: "string" }
  }
});
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
 * @param {string} filename - YAML path on disk.
 * @param {string} file - Relative display path.
 */
const readYaml = (filename, file) => {
  const source = readFileSync(filename, "utf-8");
  let reason = "invalid YAML syntax";
  try {
    const events = parseEvents(source, {});
    reason = "invalid YAML value, tag, or alias";
    const documents = constructFromEvents(events, {
      schema: CORE_SCHEMA,
      source
    });
    if (documents.length !== 1) {
      return {
        error: {
          column: 1,
          file,
          kind: "parse",
          line: 1,
          message: "Expected one YAML document."
        }
      };
    }
    return { events, source, value: documents[0] };
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
      error: {
        column: (mark?.column ?? 0) + 1,
        file,
        kind: "parse",
        line: (mark?.line ?? 0) + 1,
        message: `${reason}.`
      }
    };
  }
};

/**
 * @typedef {NonNullable<ReturnType<typeof eventsToAst>[number]["contents"]>} YamlNode
 */

/**
 * @typedef {{name: string, node: YamlNode, line: number, uses: number[]}} Anchor
 */

/**
 * @param {ReturnType<typeof parseEvents>} events - Events in YAML source order.
 * @param {string} source - Original YAML used for source locations.
 */
const indexSyntax = (events, source) => {
  const documents = eventsToAst(events, { schema: CORE_SCHEMA, source });
  const nodes = events.filter((event) => "anchorStart" in event).values();
  const breaks = source.matchAll(/\r\n|\r|\n/gu);
  let nextBreak = breaks.next().value;
  let line = 1;
  /** @type {Map<string, Anchor>} */
  const definitions = new Map();
  /** @type {Map<YamlNode, {anchor: Anchor | null, line: number, node: YamlNode}>} */
  const locations = new Map();
  visit(documents, (node) => {
    const event = nodes.next().value;
    if (event === undefined) {
      throw new Error("YAML tree and source events differ.");
    }
    let offset = event.anchorStart - 1;
    if (offset < 0 && "valueStart" in event) {
      offset = event.valueStart;
    } else if (offset < 0 && "start" in event) {
      offset = event.start;
    }
    while (nextBreak !== undefined && nextBreak.index < offset) {
      line += 1;
      nextBreak = breaks.next().value;
    }
    let anchor = null;
    if (node.kind === "alias") {
      anchor = definitions.get(node.anchor) ?? null;
      anchor?.uses.push(line);
    } else if (node.anchor !== undefined) {
      anchor = { line, name: node.anchor, node, uses: [] };
      definitions.set(node.anchor, anchor);
    }
    locations.set(node, { anchor, line, node });
  });
  return { locations, rootNode: documents[0]?.contents ?? null };
};

/**
 * @param {ReturnType<typeof indexSyntax>["locations"]} locations - YAML node locations and anchor links.
 * @param {YamlNode | undefined} node - Resolved parent node.
 * @param {number | string} segment - Mapping key or sequence index.
 */
const childAt = (locations, node, segment) => {
  if (node?.kind === "mapping") {
    const entry = node.items.find(({ key }) => {
      const resolved = locations.get(key)?.anchor?.node ?? key;
      return resolved.kind === "scalar" && resolved.value === segment;
    });
    if (entry !== undefined) {
      return {
        key: locations.get(entry.key),
        value: locations.get(entry.value)
      };
    }
  } else if (node?.kind === "sequence" && typeof segment === "number") {
    const item = node.items[segment];
    if (item !== undefined) {
      return { key: null, value: locations.get(item) };
    }
  }
  return { key: null, value: null };
};

/**
 * @param {ReturnType<typeof indexSyntax>} syntax - YAML locations and anchor links.
 * @param {(number | string)[]} segments - Mapping keys and sequence indexes leading to a node.
 */
const traceNode = ({ locations, rootNode }, segments) => {
  let current = rootNode === null ? null : locations.get(rootNode);
  /** @type {ReturnType<typeof childAt>[]} */
  const trail = [{ key: null, value: current }];
  for (const segment of segments) {
    const child = childAt(
      locations,
      current?.anchor?.node ?? current?.node,
      segment
    );
    trail.push(child);
    current = child.value;
  }
  return trail;
};

/**
 * @param {ReturnType<typeof traceNode>} trail - Input path including its original YAML nodes.
 */
const inspectInput = (trail) => {
  const terminal = trail.at(-1);
  const value = terminal?.value;
  const key = terminal?.key;
  const valueIsAlias = value?.node.kind === "alias";
  const aliasLine =
    trail.slice(0, -1).find((entry) => entry.value?.node.kind === "alias")
      ?.value?.line ?? null;
  return {
    aliasLine,
    anchors: new Set(
      trail
        .flatMap((entry) => [entry.key?.anchor, entry.value?.anchor])
        .filter((anchor) => anchor !== null && anchor !== undefined)
    ),
    line:
      aliasLine ?? (valueIsAlias ? value?.line : key?.line) ?? value?.line ?? 1,
    ownAnchors: [
      key?.node.kind === "scalar" ? (key.anchor ?? null) : null,
      value?.node.kind === "scalar" ? (value.anchor ?? null) : null
    ],
    valueIsAlias
  };
};

/**
 * @param {unknown} value - Resolved YAML input value.
 * @param {{contextDependent?: boolean, default?: string} | undefined} approved - Approved input metadata, if available.
 */
const matchesDefault = (value, approved) => {
  const scalar =
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
      ? String(value)
      : null;
  return (
    scalar !== null &&
    !scalar.includes("${{") &&
    approved?.contextDependent !== true &&
    scalar === approved?.default
  );
};

/**
 * @param {string} file - Relative workflow path for diagnostics.
 * @param {ReturnType<typeof inspectInput>} input - The syntax at the input and its anchor path.
 * @param {string} name - Action input name as spelled in the workflow.
 * @param {string} ref - Exact action reference.
 * @param {string[]} actions - Actions sharing the input mapping.
 * @param {boolean} defaultsAgree - Every shared action has the same approved default.
 */
const inputDiagnostic = (file, input, name, ref, actions, defaultsAgree) => {
  const { aliasLine, anchors, line, ownAnchors, valueIsAlias } = input;
  const linked = [...anchors].filter((anchor) => anchor.uses.length > 0);
  const locations = linked.map((anchor) => ({
    definition: { file, line: anchor.line },
    name: anchor.name,
    uses: anchor.uses.map((use) => ({ file, line: use }))
  }));
  const subject = `${name} for ${ref}`;
  const detail = locations
    .map(
      (anchor) =>
        `&${anchor.name} is defined at ${file}:${anchor.definition.line} and used at ${anchor.uses.map((use) => `${file}:${use.line}`).join(", ")}.`
    )
    .join(" ");
  const diagnostic = {
    actions,
    anchors: locations,
    file,
    input: name,
    line,
    ref
  };
  if (aliasLine !== null) {
    return {
      ...diagnostic,
      kind: "detach",
      message:
        `Detach the mapping for ${subject} at this use and leave the shared definition in place. ${detail}`.trim()
    };
  }
  if (valueIsAlias || linked.length > 0) {
    return defaultsAgree
      ? {
          ...diagnostic,
          kind: "hand-edit",
          message:
            `Hand edit ${subject} and preserve the alias references. ${detail}`.trim()
        }
      : {
          ...diagnostic,
          kind: "shared-definition",
          message:
            `Hand edit ${subject} without removing it from the definition shared by ${actions.join(", ")}. ${detail}`.trim()
        };
  }
  const removed = [
    ...new Set(
      ownAnchors.flatMap((anchor) => (anchor === null ? [] : [anchor.name]))
    )
  ];
  const suffix =
    removed.length === 0
      ? ""
      : ` Remove ${removed.map((anchor) => `&${anchor}`).join(", ")} with the input.`;
  return {
    ...diagnostic,
    kind: "omit",
    message: `Omit ${subject}. It equals the action default.${suffix}`,
    removedAnchors: removed
  };
};

/**
 * @param {string} filename - Workflow path on disk.
 * @param {string} file - Relative workflow path for diagnostics.
 * @param {z.infer<typeof metadataSchema>} metadata - Approved inputs by exact action ref.
 * @returns {(ReturnType<typeof inputDiagnostic> | NonNullable<ReturnType<typeof readYaml>["error"]>)[]} Workflow diagnostics.
 */
const validateWorkflowActionDefaults = (filename, file, metadata) => {
  const document = readYaml(filename, file);
  if (document.error !== undefined) {
    return [document.error];
  }
  const parsed = workflow.safeParse(document.value);
  if (!parsed.success) {
    return [];
  }
  const syntax = indexSyntax(document.events, document.source);
  const steps = Object.entries(parsed.data.jobs).flatMap(
    ([job, { steps: jobSteps = [] }]) =>
      jobSteps.flatMap((step, index) => {
        const action = actionStep.safeParse(step);
        const segments = ["jobs", job, "steps", index, "with"];
        const entry = traceNode(syntax, segments).at(-1)?.value;
        const mapping = entry?.anchor?.node ?? entry?.node;
        return action.success && mapping?.kind === "mapping"
          ? [{ action: action.data, mapping, segments }]
          : [];
      })
  );
  const users = Map.groupBy(steps, ({ mapping }) => mapping);
  return steps.flatMap(({ action, mapping, segments }) => {
    const { uses: ref, with: inputs } = action;
    if (!Object.hasOwn(metadata, ref)) {
      return [];
    }
    const actions = [
      ...new Set(users.get(mapping)?.map(({ action: user }) => user.uses))
    ];
    return [
      ...Map.groupBy(Object.entries(inputs), ([name]) => name.toLowerCase())
    ].flatMap(([normalized, entries]) => {
      const [[name, value]] = entries;
      if (
        entries.length !== 1 ||
        !matchesDefault(value, metadata[ref].inputs[normalized])
      ) {
        return [];
      }
      const trail = traceNode(syntax, [...segments, name]);
      const entry = trail.at(-1)?.value;
      const node = entry?.anchor?.node ?? entry?.node;
      const defaultsAgree = actions.every(
        (use) =>
          Object.hasOwn(metadata, use) &&
          matchesDefault(value, metadata[use].inputs[normalized])
      );
      return node?.kind === "scalar"
        ? [
            inputDiagnostic(
              file,
              inspectInput(trail),
              name,
              ref,
              actions,
              defaultsAgree
            )
          ]
        : [];
    });
  });
};

const metadataFile = "rules/workflow-action-defaults.yaml";
if (options.help === true) {
  process.stdout.write(
    "Check workflow action inputs against approved defaults.\n\n--workflows <directory>  Scan a different workflow directory.\n--json                   Print structured diagnostics.\n"
  );
} else {
  const metadataDocument = readYaml(
    path.join(root, metadataFile),
    metadataFile
  );
  const metadata = metadataSchema.safeParse(metadataDocument.value);
  const directory = options.workflows ?? path.join(root, ".github/workflows");
  /** @type {{column?: number, file: string, kind: string, line: number, message: string}[]} */
  const errors = metadata.success
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
        .map((entry) => entry.name)
        .toSorted()
        .flatMap((name) =>
          validateWorkflowActionDefaults(
            path.join(directory, name),
            options.workflows === undefined
              ? path.join(".github/workflows", name)
              : name,
            metadata.data
          )
        )
    : [
        metadataDocument.error ?? {
          file: metadataFile,
          kind: "metadata",
          line: 1,
          message: "Invalid action metadata."
        }
      ];
  if (errors.length > 0) {
    const output =
      options.json === true
        ? JSON.stringify(errors)
        : errors
            .map(
              (error) =>
                `${error.file}:${error.line}${"column" in error ? `:${error.column}` : ""}: ${error.message}`
            )
            .join("\n");
    process.stderr.write(`${output}\n`);
    process.exitCode = 1;
  }
}
