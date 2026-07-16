import {
  AGENT_OUTPUT_SCHEMAS,
  architectureSchema,
  securitySchema,
  qualitySchema,
} from './agent-output.schemas';

const validArchitecture = {
  architecture_pattern: 'Orchestrator-worker over a topic exchange',
  modules: ['api-gateway', 'orchestrator'],
  module_responsibilities: [
    { module: 'api-gateway', responsibility: 'OAuth, job trigger, export.' },
  ],
  request_flows: [
    { name: 'Analyze', steps: ['AnalyzeController', 'JobsService'] },
  ],
  design_patterns: ['Dependency Injection'],
  summary: 'A message-driven pipeline.',
};

describe('agent output validation', () => {
  it('accepts a well-formed architecture output', () => {
    const r = architectureSchema.validate(validArchitecture, 'architecture');
    expect(r.ok).toBe(true);
  });

  it('rejects the {raw} shape that used to be recorded as success', () => {
    // The regression this whole layer exists for. safeParseJson caught a parse
    // failure and returned `{ raw: "<whatever the model said>" }`, and the
    // caller marked it success: true. Nothing downstream could tell it from a
    // real analysis — the synthesizer's "did everything fail?" guard counted it
    // as a win and fed the string to the model as structured data.
    const r = architectureSchema.validate(
      { raw: "I'm sorry, I can't help with that." },
      'architecture',
    );

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.errors.join(' ')).toContain('required field missing');
  });

  it('rejects an empty object', () => {
    const r = architectureSchema.validate({}, 'architecture');
    expect(r.ok).toBe(false);
  });

  it('names the specific missing field, with a path', () => {
    const { summary, ...noSummary } = validArchitecture;
    void summary;
    const r = architectureSchema.validate(noSummary, 'architecture');

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.errors).toContain('architecture.summary: required field missing');
  });

  it('reports a path into nested arrays', () => {
    const r = architectureSchema.validate(
      {
        ...validArchitecture,
        module_responsibilities: [
          { module: 'api-gateway', responsibility: 'ok' },
          { module: 'orchestrator' }, // responsibility missing
        ],
      },
      'architecture',
    );

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.errors).toContain(
      'architecture.module_responsibilities[1].responsibility: required field missing',
    );
  });

  it('rejects an invented enum value', () => {
    const r = qualitySchema.validate(
      {
        error_handling_score: 'excellent', // not in the enum
        type_safety_score: 'good',
        test_coverage_signal: 'present',
        issues: [],
        summary: 'ok',
      },
      'quality',
    );

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.errors.join(' ')).toContain(
      'expected one of good | partial | poor',
    );
  });

  it('treats absent auth_mechanism as an error but null as a finding', () => {
    // "This codebase has no auth" is a real, reportable answer. Saying nothing
    // is not — so the field is nullable, not optional.
    const base = {
      auth_flow_steps: [],
      vulnerabilities: [],
      missing_protections: ['No authentication of any kind'],
      secrets_exposure_risk: false,
      summary: 'No auth layer exists.',
    };

    expect(
      securitySchema.validate({ ...base, auth_mechanism: null }, 's').ok,
    ).toBe(true);
    expect(securitySchema.validate(base, 's').ok).toBe(false);
  });

  it('allows optional fields to be absent', () => {
    // module_dependencies / entry_points / framework are about to become
    // graph-owned; the model omitting them must not fail the run.
    const r = architectureSchema.validate(validArchitecture, 'architecture');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value).not.toHaveProperty('module_dependencies');
  });

  it('drops unknown keys instead of failing an otherwise good analysis', () => {
    const r = architectureSchema.validate(
      { ...validArchitecture, vibes: 'immaculate' },
      'architecture',
    );

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value).not.toHaveProperty('vibes');
  });
});

describe('emitted JSON Schema', () => {
  it('is shaped for strict tool use', () => {
    // additionalProperties:false + a required array are what Anthropic's strict
    // mode demands. Sonnet 4.6 doesn't support structured outputs, so strict is
    // off for now — but the schema the emit_* tool advertises is generated from
    // the same definition the validator enforces, so the two cannot drift.
    const s = architectureSchema.jsonSchema as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };

    expect(s.type).toBe('object');
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toContain('summary');
    expect(s.required).not.toContain('module_dependencies'); // optional
    expect(s.properties).toHaveProperty('request_flows');
  });

  it('covers every dispatchable agent type', () => {
    expect(Object.keys(AGENT_OUTPUT_SCHEMAS).sort()).toEqual([
      'architecture',
      'dependency',
      'docs',
      'quality',
      'security',
    ]);
  });
});
