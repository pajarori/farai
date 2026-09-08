import AjvDraft7, { type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";

const validatorCache = new WeakMap<Record<string, unknown>, ValidateFunction>();

const draft7 = new AjvDraft7({ allErrors: false, strict: false, validateFormats: false, allowUnionTypes: true });
const draft2019 = new Ajv2019({ allErrors: false, strict: false, validateFormats: false, allowUnionTypes: true });
const draft2020 = new Ajv2020({ allErrors: false, strict: false, validateFormats: false, allowUnionTypes: true });

export function validateToolArgs(schema: Record<string, unknown> | undefined, args: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "expected an object of arguments";
  let validate: ValidateFunction;
  try {
    validate = compiledValidator(schema);
  } catch (error) {
    return `invalid tool input schema: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (validate(args)) return undefined;
  const error = validate.errors?.[0];
  if (!error) return "arguments do not match the tool input schema";
  return `${formatValidationError(error, schema)}${compositionShapes(error, schema)}`;
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
  return enumOwner
    ? `unexpected field "${field}"; use field "${enumOwner}" with value "${property}"`
    : `unexpected field "${field}"`;
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
