/**
 * A ~150-line schema kit: every spec emits **both** a JSON Schema and a runtime
 * validator, from one definition.
 *
 * Why not zod: it isn't a direct dependency, and the project hand-rolls its
 * agent machinery on purpose (CLAUDE.md — no agent frameworks). More
 * importantly, one source is the actual requirement here. The agent's `emit_*`
 * tool needs a JSON Schema; the consumer needs a validator. Maintaining those as
 * two hand-written artifacts guarantees they drift, and the failure mode of that
 * drift is silent: the model is told one shape and the reader checks another.
 *
 * Scope is deliberately small — objects, arrays, strings, numbers, booleans,
 * enums, nullables. That is the whole surface of the agent output types.
 */

export type JsonSchema = Record<string, unknown>;

export type Validated<T> =
  { ok: true; value: T } | { ok: false; errors: string[] };

export interface Spec<T> {
  readonly jsonSchema: JsonSchema;
  /** `path` is a dotted breadcrumb used only to build readable error messages. */
  validate(input: unknown, path: string): Validated<T>;
}

/** Marks a field as omittable. Only meaningful inside `obj`. */
export interface OptionalSpec<T> extends Spec<T | undefined> {
  readonly __optional: true;
  readonly inner: Spec<T>;
}

const err = (path: string, msg: string) => ({
  ok: false as const,
  errors: [`${path}: ${msg}`],
});
const ok = <T>(value: T) => ({ ok: true as const, value });

const typeName = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

export const str = (): Spec<string> => ({
  jsonSchema: { type: 'string' },
  validate: (v, path) =>
    typeof v === 'string'
      ? ok(v)
      : err(path, `expected string, got ${typeName(v)}`),
});

export const num = (): Spec<number> => ({
  jsonSchema: { type: 'number' },
  validate: (v, path) =>
    typeof v === 'number' && Number.isFinite(v)
      ? ok(v)
      : err(path, `expected number, got ${typeName(v)}`),
});

export const bool = (): Spec<boolean> => ({
  jsonSchema: { type: 'boolean' },
  validate: (v, path) =>
    typeof v === 'boolean'
      ? ok(v)
      : err(path, `expected boolean, got ${typeName(v)}`),
});

export const enumOf = <const T extends readonly string[]>(
  values: T,
): Spec<T[number]> => ({
  jsonSchema: { type: 'string', enum: [...values] },
  validate: (v, path) =>
    typeof v === 'string' && (values as readonly string[]).includes(v)
      ? ok(v as T[number])
      : err(
          path,
          `expected one of ${values.join(' | ')}, got ${JSON.stringify(v)}`,
        ),
});

export const arr = <T>(item: Spec<T>): Spec<T[]> => ({
  jsonSchema: { type: 'array', items: item.jsonSchema },
  validate: (v, path) => {
    if (!Array.isArray(v))
      return err(path, `expected array, got ${typeName(v)}`);
    const out: T[] = [];
    const errors: string[] = [];
    v.forEach((el, i) => {
      const r = item.validate(el, `${path}[${i}]`);
      if (r.ok) out.push(r.value);
      else errors.push(...r.errors);
    });
    return errors.length ? { ok: false, errors } : ok(out);
  },
});

export const nullable = <T>(inner: Spec<T>): Spec<T | null> => ({
  jsonSchema: { anyOf: [inner.jsonSchema, { type: 'null' }] },
  validate: (v, path) => (v === null ? ok(null) : inner.validate(v, path)),
});

export const optional = <T>(inner: Spec<T>): OptionalSpec<T> => ({
  __optional: true,
  inner,
  jsonSchema: inner.jsonSchema,
  validate: (v, path) =>
    v === undefined ? ok(undefined) : inner.validate(v, path),
});

const isOptional = (s: Spec<unknown>): boolean =>
  (s as { __optional?: boolean }).__optional === true;

type Shape = Record<string, Spec<unknown>>;

type Infer<S extends Shape> = {
  [K in keyof S]: S[K] extends Spec<infer T> ? T : never;
};

/**
 * An object spec. Fields wrapped in `optional()` may be absent; everything else
 * is required and its absence is an error, not a shrug.
 *
 * `additionalProperties: false` is always emitted — required for Anthropic's
 * strict tool use, and it also stops a model from inventing a sibling field that
 * silently goes nowhere.
 *
 * Strict IS on (see `base.agent.ts`'s emit tool). The earlier note here — that
 * strict expects *every* property in `required`, so `optional()` fields must
 * first become `nullable` + required — does not match the API's behaviour: a
 * `required` list that omits the optional fields is accepted as-is, verified
 * against haiku-4-5 and sonnet-4-6. Both also report `structured_outputs: true`
 * on the Models API, so the claim that Sonnet 4.6 lacks them was wrong too.
 */
export const obj = <S extends Shape>(shape: S): Spec<Infer<S>> => {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(shape)) {
    properties[key] = spec.jsonSchema;
    if (!isOptional(spec)) required.push(key);
  }

  return {
    jsonSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    validate: (v, path) => {
      if (typeof v !== 'object' || v === null || Array.isArray(v))
        return err(path, `expected object, got ${typeName(v)}`);

      const input = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const errors: string[] = [];

      for (const [key, spec] of Object.entries(shape)) {
        const at = path ? `${path}.${key}` : key;
        if (!(key in input) || input[key] === undefined) {
          if (isOptional(spec)) continue;
          errors.push(`${at}: required field missing`);
          continue;
        }
        const r = spec.validate(input[key], at);
        if (r.ok) {
          if (r.value !== undefined) out[key] = r.value;
        } else errors.push(...r.errors);
      }

      // Unknown keys are dropped rather than rejected: a model adding an extra
      // field is noise, not a reason to throw away an otherwise valid analysis
      // we already paid for.
      return errors.length ? { ok: false, errors } : ok(out as Infer<S>);
    },
  };
};
