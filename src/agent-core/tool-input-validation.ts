import AjvDraft7, { type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import { stripModelDeadlineArg } from "./tool-execution-control";

const validatorCache = new WeakMap<Record<string, unknown>, ValidateFunction>();

const draft7 = new AjvDraft7({ allErrors: false, strict: false, validateFormats: false, allowUnionTypes: true });
const draft2019 = new Ajv2019({ allErrors: false, strict: false, validateFormats: false, allowUnionTypes: true });
const draft2020 = new Ajv2020({ allErrors: false, strict: false, validateFormats: false, allowUnionTypes: true });

export function validateToolArgs(schema: Record<string, unknown> | undefined, rawArgs: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return "expected an object of arguments";
  const args = stripModelDeadlineArg(rawArgs);
  const selectedBranch = selectDiscriminatedBranch(schema, args as Record<string, unknown>);
  if (selectedBranch?.error) return selectedBranch.error;
  if (selectedBranch?.schema) return validateAgainstSchema(selectedBranch.schema, args);
  return validateAgainstSchema(schema, args);
}

export function validateAgainstSchema(schema: Record<string, unknown>, args: unknown, label = "tool input"): string | undefined {
  let validate: ValidateFunction;
  try {
    validate = compiledValidator(schema);
  } catch (error) {
    return `invalid ${label} schema: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (validate(args)) return undefined;
  const error = validate.errors?.[0];
  if (!error) return `arguments do not match the ${label} schema`;
  return `${formatValidationError(error, schema)}${compositionShapes(error, schema)}`;
}

function selectDiscriminatedBranch(schema: Record<string, unknown>, args: Record<string, unknown>): { schema?: Record<string, unknown>; error?: string } | undefined {
  if (!Array.isArray(schema.oneOf)) return undefined;
  const branches = schema.oneOf.filter((branch): branch is Record<string, unknown> => Boolean(branch) && typeof branch === "object" && !Array.isArray(branch));
  const operations = branches.flatMap((branch) => {
    if (!branch || typeof branch !== "object" || Array.isArray(branch)) return [];
    const properties = (branch as Record<string, unknown>).properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
    const operation = (properties as Record<string, unknown>).operation;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return [];
    const value = (operation as Record<string, unknown>).const;
    return typeof value === "string" ? [value] : [];
  });
  if (!operations.length) return undefined;
  if (typeof args.operation !== "string") return { error: "missing required field \"operation\"" };
  if (!operations.includes(args.operation)) return { error: `field \"operation\" must be one of: ${operations.join(", ")}` };
  const branch = branches.find((candidate) => {
    const properties = candidate.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
    const operation = (properties as Record<string, unknown>).operation;
    return Boolean(operation) && typeof operation === "object" && !Array.isArray(operation) && (operation as Record<string, unknown>).const === args.operation;
  });
  return branch ? { schema: branch } : undefined;
}

function compiledValidator(schema: Record<string, unknown>): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
  const ajv = dialect.includes("2020-12") ? draft2020 : dialect.includes("2019-09") ? draft2019 : draft7;
  const validate = ajv.compile(schema);
  validatorCache.set(schema, validate);
  return validate;
}

function formatValidationError(error: ErrorObject, schema: Record<string, unknown>): string {
  const path = pointerPath(error.instancePath);
  switch (error.keyword) {
    case "required":
      return `missing required field "${joinFieldPath(path, String(error.params.missingProperty ?? ""))}"`;
    case "additionalProperties":
      return unexpectedFieldError(path, String(error.params.additionalProperty ?? ""), schema);
    case "type":
      return `${fieldName(path)} should be of type ${String(error.params.type ?? "the declared schema type")}`;
    case "enum":
      return `${fieldName(path)} must be one of: ${Array.isArray(error.params.allowedValues) ? error.params.allowedValues.join(", ") : "the declared values"}`;
    case "const":
      return `${fieldName(path)} must equal ${JSON.stringify(error.params.allowedValue)}`;
    case "minLength":
      return `${fieldName(path)} must contain at least ${String(error.params.limit)} character(s)`;
    case "maxLength":
      return `${fieldName(path)} cannot exceed ${String(error.params.limit)} character(s)`;
    case "pattern":
      return `${fieldName(path)} does not match the required pattern`;
    case "minimum":
      return `${fieldName(path)} must be at least ${String(error.params.limit)}`;
    case "maximum":
      return `${fieldName(path)} cannot exceed ${String(error.params.limit)}`;
    case "exclusiveMinimum":
      return `${fieldName(path)} must be greater than ${String(error.params.limit)}`;
    case "exclusiveMaximum":
      return `${fieldName(path)} must be less than ${String(error.params.limit)}`;
    case "multipleOf":
      return `${fieldName(path)} must be a multiple of ${String(error.params.multipleOf)}`;
    case "minItems":
      return `${fieldName(path)} must contain at least ${String(error.params.limit)} item(s)`;
    case "maxItems":
      return `${fieldName(path)} cannot contain more than ${String(error.params.limit)} item(s)`;
    case "uniqueItems":
      return `${fieldName(path)} must contain unique items`;
    case "minProperties":
      return `${fieldName(path)} must contain at least ${String(error.params.limit)} field(s)`;
    case "maxProperties":
      return `${fieldName(path)} cannot contain more than ${String(error.params.limit)} field(s)`;
    case "oneOf":
      return `${fieldName(path)} must match exactly one allowed shape`;
    case "anyOf":
      return `${fieldName(path)} must match one allowed shape`;
    case "not":
      return `${fieldName(path)} matches a forbidden shape`;
    default:
      return `${fieldName(path)} ${error.message ?? `failed ${error.keyword} validation`}`;
  }
}

function compositionShapes(error: ErrorObject, schema: Record<string, unknown>): string {
  const compositionPath = compositionPointer(error.schemaPath);
  const branches = compositionPath ? resolveSchemaPointer(schema, compositionPath) : undefined;
  if (!Array.isArray(branches) || branches.length < 2) return "";
  const shapes = branches
    .map(describeBranch)
    .filter((text): text is string => Boolean(text));
  if (shapes.length < 2) return "";
  return `; provide exactly one shape: ${shapes.map((text, index) => `${index + 1}) ${text}`).join(" or ")}`;
}

function compositionPointer(schemaPath: string): string | undefined {
  if (typeof schemaPath !== "string") return undefined;
  const segments = schemaPath.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index] === "oneOf" || segments[index] === "anyOf") {
      return segments.slice(0, index + 1).join("/");
    }
  }
  return undefined;
}

function describeBranch(branch: unknown): string | undefined {
  if (!branch || typeof branch !== "object" || Array.isArray(branch)) return undefined;
  const record = branch as Record<string, unknown>;
  const required = Array.isArray(record.required) ? record.required.map(String) : [];
  const properties = record.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const operation = (properties as Record<string, unknown>).operation;
    if (operation && typeof operation === "object" && !Array.isArray(operation) && typeof (operation as Record<string, unknown>).const === "string") {
      return `{ operation: ${(operation as Record<string, unknown>).const}, args }`;
    }
  }
  if (required.length > 0) return `{ ${required.join(", ")} }`;
  if (typeof record.type === "string") return `a ${record.type}`;
  if (typeof record.const !== "undefined") return JSON.stringify(record.const);
  return undefined;
}

function resolveSchemaPointer(schema: Record<string, unknown>, schemaPath: string): unknown {
  if (typeof schemaPath !== "string") return undefined;
  const pointer = schemaPath.startsWith("#") ? schemaPath.slice(1) : schemaPath;
  let node: unknown = schema;
  for (const raw of pointer.split("/")) {
    if (!raw) continue;
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) node = node[Number(key)];
    else if (node && typeof node === "object") node = (node as Record<string, unknown>)[key];
    else return undefined;
  }
  return node;
}

function unexpectedFieldError(path: string, property: string, schema: Record<string, unknown>): string {
  const field = joinFieldPath(path, property);
  const enumOwner = enumOwnerForValue(schema, property);
  if (enumOwner) return `unexpected field "${field}"; use field "${enumOwner}" with value "${property}"`;
  const accepted = acceptedFieldsAt(schema, path);
  return accepted.length
    ? `unexpected field "${field}"; accepted fields are: ${accepted.join(", ")}`
    : `unexpected field "${field}"`;
}

function acceptedFieldsAt(schema: Record<string, unknown>, path: string): string[] {
  let node: unknown = schema;
  const segments = path ? path.split(".").filter(Boolean) : [];
  for (const segment of segments) {
    if (!node || typeof node !== "object") return [];
    const record = node as Record<string, unknown>;
    if (/^\[\d+\]$/.test(segment)) node = record.items;
    else {
      const properties = record.properties;
      node = properties && typeof properties === "object" ? (properties as Record<string, unknown>)[segment.replace(/\[\d+\]$/, "")] : undefined;
    }
  }
  const target = collectAcceptedProperties(node);
  return [...target];
}

function collectAcceptedProperties(node: unknown): Set<string> {
  const names = new Set<string>();
  if (!node || typeof node !== "object" || Array.isArray(node)) return names;
  const record = node as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    for (const key of Object.keys(record.properties as Record<string, unknown>)) names.add(key);
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const branches = record[key];
    if (Array.isArray(branches)) for (const branch of branches) for (const name of collectAcceptedProperties(branch)) names.add(name);
  }
  return names;
}

function enumOwnerForValue(schema: unknown, value: string): string | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
      if (propertySchema && typeof propertySchema === "object" && !Array.isArray(propertySchema)) {
        const allowed = (propertySchema as Record<string, unknown>).enum;
        if (Array.isArray(allowed) && allowed.includes(value)) return name;
      }
    }
  }
  for (const nested of Object.values(record)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const owner = enumOwnerForValue(item, value);
        if (owner) return owner;
      }
    } else {
      const owner = enumOwnerForValue(nested, value);
      if (owner) return owner;
    }
  }
  return undefined;
}

function pointerPath(pointer: string): string {
  if (!pointer) return "";
  let path = "";
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    path = /^\d+$/.test(segment) ? `${path}[${segment}]` : joinFieldPath(path, segment);
  }
  return path;
}

function joinFieldPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function fieldName(path: string): string {
  return path ? `field "${path}"` : "value";
}
