import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  constructFromEvents,
  CORE_SCHEMA,
  eventsToAst,
  parseEvents,
  SCALAR_STYLE,
  visit,
  YAMLException
} from "js-yaml";
import { z } from "zod";

const inputMetadata = z
  .object({
    contextDependent: z.string().min(1).optional(),
    default: z
      .union([z.string(), z.boolean(), z.number(), z.null()])
      .optional(),
    noDefault: z.literal(true).optional()
  })
  .refine((input) =>
    input.noDefault === true
      ? input.default === undefined && input.contextDependent === undefined
      : input.default !== undefined || input.contextDependent !== undefined
  );
const metadataSchema = z
  .record(
    z.string(),
    z.object({
      commit: z.hash("sha1").nullable(),
      inputs: z.record(z.string().toLowerCase(), inputMetadata)
    })
  )
  .refine((records) =>
    Object.entries(records).every(
      ([ref, record]) => ref.startsWith("./") === (record.commit === null)
    )
  );
const triggers = z.union([
  z.string(),
  z.array(z.string()),
  z.record(z.string(), z.unknown())
]);
const workflow = z.object({
  env: z.unknown().optional(),
  jobs: z.record(
    z.string(),
    z.object({
      env: z.unknown().optional(),
      steps: z.array(z.unknown()).optional()
    })
  ),
  on: z.unknown().optional()
});
const actionStep = z.object({
  if: z.unknown().optional(),
  uses: z.string(),
  with: z.unknown().optional()
});
const stepInputs = z.record(z.string(), z.unknown());
const workflowCheckout = z.strictObject({
  id: z.string().optional(),
  name: z.string().optional(),
  uses: z.string(),
  with: stepInputs
});
const root = fileURLToPath(new URL("../", import.meta.url));
const { values: options } = parseArgs({
  options: {
    help: { type: "boolean" },
    json: { type: "boolean" },
    "list-metadata": { type: "boolean" },
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
const decimalNumber =
  /^[-+]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/u;

const parseYaml = (source: string, file: string) => {
  let reason = "invalid YAML syntax";
  try {
    const events = parseEvents(source, {});
    reason = "invalid YAML value, tag, or alias";
    const documents = constructFromEvents(events, {
      schema: CORE_SCHEMA,
      source
    });
    if (documents.length > 1) {
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

type YamlNode = NonNullable<ReturnType<typeof eventsToAst>[number]["contents"]>;

interface Anchor {
  name: string;
  node: YamlNode;
  line: number;
  uses: number[];
}

const indexSyntax = (
  events: ReturnType<typeof parseEvents>,
  source: string
) => {
  const documents = eventsToAst(events, { schema: CORE_SCHEMA, source });
  const nodes = events.filter((event) => "anchorStart" in event).values();
  const breaks = source.matchAll(/\r\n|\r|\n/gu);
  let nextBreak = breaks.next().value;
  let line = 1;
  const definitions = new Map<string, Anchor>();
  const locations = new Map<
    YamlNode,
    { anchor: Anchor | null; line: number; node: YamlNode }
  >();
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

const childAt = (
  locations: ReturnType<typeof indexSyntax>["locations"],
  node: YamlNode | undefined,
  segment: number | string
) => {
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

const traceNode: (
  syntax: ReturnType<typeof indexSyntax>,
  segments: (number | string)[]
) => ReturnType<typeof childAt>[] = ({ locations, rootNode }, segments) => {
  let current = rootNode === null ? null : locations.get(rootNode);
  const trail: ReturnType<typeof childAt>[] = [{ key: null, value: current }];
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

const inspectInput = (trail: ReturnType<typeof traceNode>) => {
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
 * .NET G15 rounds the exact binary value to nearest, with ties to even.
 */
const roundSignificand = (magnitude: number) => {
  const exponent = Number(magnitude.toExponential().split("e")[1]);
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, magnitude);
  const encoding = bits.getBigUint64(0);
  const leadingBit = 2n ** 52n;
  const biasedExponent = encoding / leadingBit;
  const fraction = encoding % leadingBit;
  const significand = biasedExponent === 0n ? fraction : fraction + leadingBit;
  const shift = (biasedExponent === 0n ? 1n : biasedExponent) - 1075n;
  const decimalShift = BigInt(14 - exponent);
  const numerator =
    significand *
    2n ** (shift > 0n ? shift : 0n) *
    10n ** (decimalShift > 0n ? decimalShift : 0n);
  const denominator =
    2n ** (shift < 0n ? -shift : 0n) *
    10n ** (decimalShift < 0n ? -decimalShift : 0n);
  const lower = numerator / denominator;
  const midpoint = (numerator % denominator) * 2n;
  const roundUp =
    midpoint > denominator || (midpoint === denominator && lower % 2n === 1n);
  const digits = (lower + BigInt(roundUp)).toString();
  return {
    digits: digits.replace(/0+$/u, ""),
    exponent: exponent + digits.length - 15
  };
};

const readRunnerNumber: (
  value: string,
  tag: "tag:yaml.org,2002:int" | "tag:yaml.org,2002:float"
) => string | null = (value, tag) => {
  const isYamlIntegerTag = tag === "tag:yaml.org,2002:int";
  if (isYamlIntegerTag && /^0[ox]/u.test(value)) {
    const whole = Number(value);
    return whole < 2 ** 32
      ? String(whole >= 2 ** 31 ? whole - 2 ** 32 : whole)
      : null;
  }
  if (!isYamlIntegerTag && /^[-+]?\.(?:inf|Inf|INF)$/u.test(value)) {
    return value.startsWith("-") ? "-Infinity" : "Infinity";
  }
  if (!isYamlIntegerTag && /^\.(?:nan|NaN|NAN)$/u.test(value)) {
    return "NaN";
  }
  return decimalNumber.test(value) ? formatRunnerNumber(Number(value)) : null;
};

const formatRunnerNumber: (value: number) => string = (value) => {
  if (Object.is(value, -0)) {
    return "-0";
  }
  if (
    !Number.isFinite(value) ||
    (Number.isInteger(value) && Math.abs(value) < 1e15)
  ) {
    return String(value);
  }
  const { digits, exponent } = roundSignificand(Math.abs(value));
  const sign = value < 0 ? "-" : "";
  const split = exponent + 1;
  if (exponent < -4 || exponent >= 15) {
    const fraction = digits.length === 1 ? "" : `.${digits.slice(1)}`;
    const exponentSign = exponent < 0 ? "-" : "+";
    const places = String(Math.abs(exponent)).padStart(2, "0");
    return `${sign}${digits[0]}${fraction}E${exponentSign}${places}`;
  }
  if (split <= 0) {
    return `${sign}0.${"0".repeat(-split)}${digits}`;
  }
  if (split >= digits.length) {
    return sign + digits.padEnd(split, "0");
  }
  return `${sign}${digits.slice(0, split)}.${digits.slice(split)}`;
};

const readRunnerScalar = (node: YamlNode | undefined) => {
  if (node?.kind !== "scalar") {
    return null;
  }
  const { value } = node;
  let { tag } = node;
  if (tag.startsWith("!!")) {
    tag = `tag:yaml.org,2002:${tag.slice(2)}`;
  } else if (tag.startsWith("!<") && tag.endsWith(">")) {
    tag = tag.slice(2, -1);
  }
  if (tag === "tag:yaml.org,2002:str") {
    if (
      !node.tagged &&
      node.style === SCALAR_STYLE.PLAIN &&
      decimalNumber.test(value)
    ) {
      return formatRunnerNumber(Number(value));
    }
    return value.includes("${{") ? null : value;
  }
  if (node.style !== SCALAR_STYLE.PLAIN) {
    return null;
  }
  if (tag === "tag:yaml.org,2002:null") {
    return "";
  }
  if (tag === "tag:yaml.org,2002:bool") {
    return value.toLowerCase();
  }
  if (tag === "tag:yaml.org,2002:int" || tag === "tag:yaml.org,2002:float") {
    return readRunnerNumber(value, tag);
  }
  return null;
};

const indexDefaults = (
  syntax: ReturnType<typeof indexSyntax>,
  metadata: z.infer<typeof metadataSchema>
): Map<string, Map<string, string>> =>
  new Map(
    Object.entries(metadata).map(([ref, { inputs }]) => [
      ref,
      new Map(
        Object.entries(inputs).flatMap(([name, approved]) => {
          if (approved.contextDependent !== undefined) {
            return [];
          }
          if (approved.noDefault === true) {
            return [[name, ""]];
          }
          const entry = traceNode(syntax, [ref, "inputs", name, "default"]).at(
            -1
          )?.value;
          const value = readRunnerScalar(entry?.anchor?.node ?? entry?.node);
          return value === null ? [] : [[name, value]];
        })
      )
    ])
  );

const hasCaller: (event: unknown) => boolean = (event) => {
  const parsed = triggers.safeParse(event);
  if (!parsed.success) {
    return true;
  }
  if (typeof parsed.data === "string") {
    return parsed.data === "workflow_call";
  }
  return Array.isArray(parsed.data)
    ? parsed.data.includes("workflow_call")
    : Object.hasOwn(parsed.data, "workflow_call");
};

const checksOutWorkflow = (
  step: unknown,
  checkoutCommit: string | null | undefined
) => {
  const checkout = workflowCheckout.safeParse(step);
  if (!checkout.success || typeof checkoutCommit !== "string") {
    return false;
  }
  const inputs = Object.entries(checkout.data.with);
  return (
    checkout.data.uses === `actions/checkout@${checkoutCommit}` &&
    inputs.length === 1 &&
    inputs[0][0].toLowerCase() === "ref" &&
    inputs[0][1] === `\${{ github.workflow_sha }}`
  );
};

const inputDiagnostic = (
  file: string,
  input: ReturnType<typeof inspectInput>,
  name: string,
  ref: string,
  actions: string[],
  defaultsAgree: boolean
) => {
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
  if (aliasLine !== null && !valueIsAlias) {
    return {
      ...diagnostic,
      kind: "detach",
      message:
        `Detach the mapping for ${subject} at this use and leave the shared definition in place. ${detail}`.trim()
    };
  }
  if (valueIsAlias || linked.length > 0) {
    return valueIsAlias || defaultsAgree
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

const localReview = (
  file: string,
  ref: string,
  line: number,
  reason: "workspace" | "metadata"
) => ({
  file,
  kind: "local-action-review",
  line,
  message: `Left ${ref} to review. ${reason === "workspace" ? "The workspace at this step is unverified." : "Approval from the workflow's own revision is unavailable."}`,
  reason,
  ref
});

const validateWorkflowActionDefaults = (
  filename: string,
  file: string,
  defaults: ReturnType<typeof indexDefaults>,
  checkoutCommit: string | null | undefined,
  sameTree: boolean
) => {
  const document = parseYaml(readFileSync(filename, "utf-8"), file);
  if (document.error !== undefined) {
    return [document.error];
  }
  const parsed = workflow.safeParse(document.value);
  if (!parsed.success) {
    return [];
  }
  const syntax = indexSyntax(document.events, document.source);
  const reviews: ReturnType<typeof localReview>[] = [];
  const steps = Object.entries(parsed.data.jobs).flatMap(
    ([job, { env, steps: jobSteps = [] }]) =>
      jobSteps.flatMap((step, index) => {
        const action = actionStep.safeParse(step);
        if (!action.success) {
          return [];
        }
        const { uses: ref } = action.data;
        const stepPath = ["jobs", job, "steps", index];
        let approved = defaults.get(ref);
        if (ref.startsWith("./")) {
          const workspaceVerified =
            index === 1 &&
            env === undefined &&
            parsed.data.env === undefined &&
            action.data.if === undefined &&
            !hasCaller(parsed.data.on) &&
            checksOutWorkflow(jobSteps[0], checkoutCommit);
          if (!workspaceVerified || !sameTree || approved === undefined) {
            const { line } = inspectInput(
              traceNode(syntax, [...stepPath, "uses"])
            );
            reviews.push(
              localReview(
                file,
                ref,
                line,
                workspaceVerified ? "metadata" : "workspace"
              )
            );
            approved = undefined;
          }
        }
        const segments = [...stepPath, "with"];
        const entry = traceNode(syntax, segments).at(-1)?.value;
        const mapping = entry?.anchor?.node ?? entry?.node;
        const inputs = stepInputs.safeParse(action.data.with);
        return inputs.success && mapping?.kind === "mapping"
          ? [{ approved, inputs: inputs.data, mapping, ref, segments }]
          : [];
      })
  );
  const users = Map.groupBy(steps, ({ mapping }) => mapping);
  const diagnostics = steps.flatMap(
    ({ approved, inputs, mapping, ref, segments }) => {
      if (approved === undefined) {
        return [];
      }
      const shared = users.get(mapping) ?? [];
      const actions = [...new Set(shared.map((user) => user.ref))];
      return [
        ...Map.groupBy(Object.entries(inputs), ([name]) => name.toLowerCase())
      ].flatMap(([normalized, entries]) => {
        const [[name]] = entries;
        if (entries.length !== 1 || !approved.has(normalized)) {
          return [];
        }
        const trail = traceNode(syntax, [...segments, name]);
        const entry = trail.at(-1)?.value;
        const value = readRunnerScalar(entry?.anchor?.node ?? entry?.node);
        return value !== null && value === approved.get(normalized)
          ? [
              inputDiagnostic(
                file,
                inspectInput(trail),
                name,
                ref,
                actions,
                shared.every((user) => value === user.approved?.get(normalized))
              )
            ]
          : [];
      });
    }
  );
  const findings: (
    | ReturnType<typeof inputDiagnostic>
    | ReturnType<typeof localReview>
    | NonNullable<ReturnType<typeof parseYaml>["error"]>
  )[] = [...diagnostics, ...reviews];
  return findings;
};

const metadataFile = "rules/workflow-action-defaults.yaml";
const workflowPath = ".github/workflows";

const formatFindings: (
  findings: { column?: number; file: string; line: number; message: string }[]
) => string = (findings) =>
  options.json === true
    ? JSON.stringify(findings)
    : findings
        .map(
          ({ file, line, column, message }) =>
            `${file}:${line}${column === undefined ? "" : `:${column}`}: ${message}`
        )
        .join("\n");

if (options.help === true) {
  process.stdout.write(
    "Check workflow action inputs against approved defaults.\n\n--workflows <directory>  Scan a different directory. Standard .github/workflows directories use metadata from their own tree.\n--json                   Print structured findings.\n--list-metadata          Print approved action metadata as JSON.\n"
  );
} else {
  const workflowDirectory = path.join(root, workflowPath);
  const directory =
    options.workflows === undefined && options["list-metadata"] === true
      ? workflowDirectory
      : realpathSync(options.workflows ?? workflowDirectory);
  const candidateRoot = path.dirname(path.dirname(directory));
  const sameTree =
    directory === path.join(candidateRoot, workflowPath) &&
    (options.workflows !== undefined || candidateRoot === path.resolve(root));
  const metadataPath = path.join(sameTree ? candidateRoot : root, metadataFile);
  const metadataSource =
    metadataPath === path.join(root, metadataFile) ||
    (existsSync(metadataPath) && realpathSync(metadataPath) === metadataPath)
      ? readFileSync(metadataPath, "utf-8")
      : "{}";
  const metadataDocument = parseYaml(metadataSource, metadataFile);
  const metadata = metadataSchema.safeParse(metadataDocument.value);
  if (!metadata.success || metadataDocument.error !== undefined) {
    const error = metadataDocument.error ?? {
      file: metadataFile,
      kind: "metadata",
      line: 1,
      message: "Invalid action metadata."
    };
    process.stderr.write(`${formatFindings([error])}\n`);
    process.exitCode = 1;
  } else if (options["list-metadata"] === true) {
    process.stdout.write(`${JSON.stringify(metadata.data)}\n`);
  } else {
    const defaults = indexDefaults(
      indexSyntax(metadataDocument.events, metadataDocument.source),
      metadata.data
    );
    const checkoutCommit = metadata.data["actions/checkout@v7"]?.commit;
    const findings = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
      .map((entry) => entry.name)
      .toSorted()
      .flatMap((name) =>
        validateWorkflowActionDefaults(
          path.join(directory, name),
          options.workflows === undefined
            ? path.join(workflowPath, name)
            : name,
          defaults,
          checkoutCommit,
          sameTree
        )
      );
    const reviews = findings.filter(
      (finding) => finding.kind === "local-action-review"
    );
    const errors = findings.filter(
      (finding) => finding.kind !== "local-action-review"
    );
    if (reviews.length > 0) {
      process.stdout.write(`${formatFindings(reviews)}\n`);
    }
    if (errors.length > 0) {
      process.stderr.write(`${formatFindings(errors)}\n`);
      process.exitCode = 1;
    }
  }
}
