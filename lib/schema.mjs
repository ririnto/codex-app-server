import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { execa } from "execa";
import { z } from "zod";

const generatedSchema = z.looseObject({
  $defs: z.record(z.string(), z.unknown()).optional(),
  definitions: z.record(z.string(), z.unknown()).optional(),
  oneOf: z.array(
    z.looseObject({
      properties: z.looseObject({
        method: z.looseObject({
          const: z.string().optional(),
          enum: z.array(z.string()).optional()
        }),
        params: z
          .union([z.record(z.string(), z.unknown()), z.boolean()])
          .optional()
      }),
      required: z.array(z.string()).optional()
    })
  )
});
const parameterInput = z.looseObject({
  $defs: z
    .record(
      z.string(),
      z.union([z.record(z.string(), z.unknown()), z.boolean()])
    )
    .optional(),
  $ref: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional()
});

const PROTOCOLS = {
  clientNotification: "ClientNotification.json",
  clientRequest: "ClientRequest.json",
  serverNotification: "ServerNotification.json",
  serverRequest: "ServerRequest.json"
};
/** @type {{key: string, value: Awaited<ReturnType<typeof generate>>} | undefined} */
let cached;
/** @type {{key: string, promise: ReturnType<typeof generate>} | undefined} */
let pending;

/**
 * @param {string} key - JSON property name.
 * @param {unknown} value - JSON property value.
 */
const rewriteReference = (key, value) =>
  key === "$ref" && typeof value === "string"
    ? value.replace("#/definitions/", "#/$defs/")
    : value;

/**
 * @param {string} binary - Codex executable.
 * @param {string} version - Codex version.
 */
const generate = async (binary, version) => {
  const directory = await mkdtemp(path.join(tmpdir(), "local-codex-schema-"));
  let result;
  try {
    await execa(
      binary,
      ["app-server", "generate-json-schema", "--out", directory],
      { timeout: 30_000 }
    );
    const hash = createHash("sha256");
    const protocols = await Promise.all(
      Object.entries(PROTOCOLS).map(async ([kind, file]) => {
        const source = await readFile(path.join(directory, file), "utf-8");
        /** @type {unknown} */
        const parsed = JSON.parse(source, rewriteReference);
        const schema = generatedSchema.parse(parsed);
        const defs = schema.definitions ?? schema.$defs ?? {};
        const entries = schema.oneOf.map((entry) => {
          const method =
            entry.properties.method.const ?? entry.properties.method.enum?.[0];
          if (method === undefined) {
            throw new Error(`Native ${kind} schema entry has no method`);
          }
          const { params } = entry.properties;
          return {
            kind,
            method,
            params:
              params === undefined || params === false
                ? null
                : { ...(params === true ? {} : params), $defs: defs },
            request: { ...entry, $defs: defs }
          };
        });
        return { entries, kind, source };
      })
    );
    for (const { kind, source } of protocols) {
      hash.update(kind).update(source);
    }
    /** @type {Map<string, ReturnType<AjvJsonSchemaValidator["getValidator"]>>} */
    const validators = new Map();
    result = {
      hash: hash.digest("hex"),
      protocols: Object.fromEntries(
        protocols.map(({ entries, kind }) => {
          /** @type {[string, typeof entries]} */
          const pair = [kind, entries];
          return pair;
        })
      ),
      validators,
      version
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
  return result;
};

/**
 * Share concurrent native schema generations and cache successful results by executable and version.
 * Explicit discovery refreshes regenerate to detect schema changes within the same CLI version.
 */
export const loadProtocol = async ({ refresh = false } = {}) => {
  const configuredBinary = process.env.CODEX_BIN;
  const binary =
    configuredBinary === undefined || configuredBinary === ""
      ? "codex"
      : configuredBinary;
  const { stdout } = await execa(binary, ["--version"], { timeout: 30_000 });
  const version = stdout.trim();
  if (!version) {
    throw new Error("Codex returned an empty version");
  }
  const key = `${binary}\0${version}`;
  if (!refresh && cached?.key === key && pending?.key !== key) {
    return cached.value;
  }
  if (pending?.key !== key) {
    pending = { key, promise: generate(binary, version) };
  }
  const current = pending;
  let result;
  try {
    const value = await current.promise;
    if (pending === current) {
      cached = { key, value };
    }
    result = value;
  } catch (error) {
    if (cached?.key === key) {
      cached = undefined;
    }
    throw error;
  } finally {
    if (pending === current) {
      pending = undefined;
    }
  }
  return result;
};

/**
 * @param {Record<string, boolean | Record<string, unknown>>} definitions - Native definitions.
 * @param {string} reference - Native schema reference.
 * @param {boolean} [fullReference] - Include the full root reference in errors.
 * @returns {[string, boolean | Record<string, unknown>]} Definition name and value.
 */
const lookupDefinition = (definitions, reference, fullReference = false) => {
  const name = reference.replace("#/$defs/", "");
  if (!Object.hasOwn(definitions, name)) {
    throw new Error(
      `Missing native schema definition: ${fullReference ? reference : name}`
    );
  }
  return [name, definitions[name]];
};

/**
 * @param {Record<string, unknown>} root - Root parameter schema.
 * @param {Record<string, boolean | Record<string, unknown>>} definitions - Native definitions.
 */
const reachableDefinitions = (root, definitions) => {
  /** @type {Record<string, boolean | Record<string, unknown>>} */
  const defs = {};
  /** @type {unknown[]} */
  const queue = [root];
  for (const value of queue) {
    if (value !== null && typeof value === "object") {
      if ("$ref" in value && typeof value.$ref !== "string") {
        throw new TypeError("Invalid native schema reference");
      }
      if (
        "$ref" in value &&
        typeof value.$ref === "string" &&
        value.$ref !== ""
      ) {
        const [name, definition] = lookupDefinition(definitions, value.$ref);
        if (!Object.hasOwn(defs, name)) {
          defs[name] = definition;
          queue.push(definition);
        }
      }
      queue.push(
        ...(Array.isArray(value)
          ? z.array(z.unknown()).parse(value)
          : Object.values(z.record(z.string(), z.unknown()).parse(value)))
      );
    }
  }
  return defs;
};

/**
 * Preserve a method's native parameter schema with only its reachable definitions.
 * Resolve root references and wrap non-object parameters in a native-validated params argument.
 * @param {unknown} params - Native parameter schema.
 * @param {boolean} [required] - Whether the method requires parameters.
 */
export const parameterSchema = (params, required = true) => {
  if (params === undefined || params === null || params === false) {
    return {
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object"
      },
      native: null,
      wrapped: false
    };
  }
  const { $defs: definitions = {}, ...source } = parameterInput.parse(params);
  let root = source;
  if (source.$ref !== undefined && source.$ref !== "") {
    const [, definition] = lookupDefinition(definitions, source.$ref, true);
    root = {
      ...(typeof definition === "object" ? definition : {}),
      ...source
    };
    delete root.$ref;
  }
  const defs = reachableDefinitions(root, definitions);
  const references = Object.keys(defs).length ? { $defs: defs } : {};
  const native = { ...root, ...references };
  const wrapped = root.type !== "object";
  const properties = Object.fromEntries(
    Object.entries(root.properties ?? {}).map(([name, schema]) => [
      name,
      schema === true ? {} : schema
    ])
  );
  for (const [name, schema] of Object.entries(properties)) {
    if (schema === false) {
      properties[name] = { not: {} };
    }
  }
  return {
    inputSchema: wrapped
      ? {
          additionalProperties: false,
          properties: { params: root },
          ...(required ? { required: ["params"] } : {}),
          type: "object",
          ...references
        }
      : { ...native, ...(root.properties === undefined ? {} : { properties }) },
    native,
    wrapped
  };
};

/**
 * Validate a native client request without changing or stripping its parameters.
 * Refuse other protocol directions and unknown methods before connecting.
 * @param {string} method - Native client request method.
 * @param {unknown} params - Native request parameters.
 */
export const validateRequest = async (method, params) => {
  const { protocols, validators } = await loadProtocol();
  const entry = protocols.clientRequest.find((item) => item.method === method);
  if (!entry) {
    throw new Error(`Not a native ClientRequest method: ${method}`);
  }
  let validator = validators.get(method);
  if (validator === undefined) {
    validator = new AjvJsonSchemaValidator().getValidator(entry.request);
    validators.set(method, validator);
  }
  const result = validator({
    id: 0,
    method,
    ...(params === undefined ? {} : { params })
  });
  if (!result.valid) {
    throw new Error(
      `Invalid ${method} request parameters: ${result.errorMessage}`
    );
  }
};
