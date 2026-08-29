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
  return error ? formatValidationError(error) : "arguments do not match the tool input schema";
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

function formatValidationError(error: ErrorObject): string {
  const path = pointerPath(error.instancePath);
  switch (error.keyword) {
    case "required":
      return `missing required field "${joinFieldPath(path, String(error.params.missingProperty ?? ""))}"`;
    case "additionalProperties":
      return `unexpected field "${joinFieldPath(path, String(error.params.additionalProperty ?? ""))}"`;
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
