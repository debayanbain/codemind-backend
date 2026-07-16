import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentContext } from './base.agent';

@Injectable()
export class SecurityAgent extends BaseAgent {
  readonly agentType = 'security' as const;

  // Real routes are the security agent's most valuable input: an audit of the
  // endpoints that exist beats an audit of endpoints it imagined.
  readonly factSections = ['overview', 'routes', 'modules'] as const;

  readonly rolePrompt = `Your brief: you are a security engineer auditing this codebase.
The routes in the Ground Truth are the real, complete attack surface — audit those,
not the ones a project like this usually has.

What to investigate:
- Trace the auth chain for real. Find the guard/middleware, get_code it, then
  get_callers to see which routes actually reach it. The valuable finding here is
  the route that SHOULD be protected and isn't — you can only find it by comparing
  the route list against what the guard actually covers.
- auth_flow_steps must be real symbol names in call order, from the code. Return []
  if there is genuinely no authentication.
- Input validation: follow user-controlled data from a handler inward. Read the DTOs
  and check whether validation is declared AND enforced (a decorator with no
  validation pipe wired up does nothing).
- Secrets: read_file the config/env handling. Look for defaults, logging of
  credentials, and tokens stored unencrypted.
- Injection: only report it if you have read the query construction and it
  concatenates untrusted input. A parameterised query is not a finding.

Rules that matter:
- **Do not invent vulnerabilities.** An empty vulnerabilities list from a genuine
  audit is a valid, useful result. A plausible-sounding CVE you did not verify is
  worse than nothing — it destroys trust in every other finding in the report.
- Every vulnerability needs a location you actually read, and a description of the
  concrete path an attacker takes. If you cannot describe the path, you have not
  found a vulnerability.
- If the notes say no Dockerfile was found, do not report container-security issues.`;

  buildUserMessage(ctx: AgentContext): string {
    return `Audit this codebase for security issues.

## Code Graph Context (auth + input handling focus)
${ctx.graphContext}

${ctx.additionalContext ? `## Manifest Notes\n${ctx.additionalContext}\n` : ''}`;
  }
}
