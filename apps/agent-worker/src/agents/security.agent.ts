import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentContext } from './base.agent';

@Injectable()
export class SecurityAgent extends BaseAgent {
  readonly agentType = 'security';

  readonly systemPrompt = `You are a security engineer auditing a codebase.
Respond ONLY with valid JSON. No preamble, no markdown fences.

Required output schema:
{
  "auth_mechanism": string | null,
  "auth_flow_steps": string[],
  "sensitive_endpoints": [{ "path": string, "method": string, "risk": "high"|"medium"|"low", "reason": string }],
  "vulnerabilities": [{ "type": string, "location": string, "severity": "critical"|"high"|"medium"|"low", "description": string }],
  "missing_protections": string[],
  "secrets_exposure_risk": boolean,
  "summary": string
}

auth_flow_steps: ordered list of components in the auth chain (e.g. ["Client", "AuthGuard", "JwtStrategy", "UsersService", "Handler"]).
Keep vulnerabilities to real findings only. Do not hallucinate vulnerabilities.
If additionalContext says no Dockerfile was found, do not report container-security findings.`;

  buildUserMessage(ctx: AgentContext): string {
    return `Audit this codebase for security issues.

## Code Graph Context (auth + input handling focus)
${ctx.graphContext}

${ctx.additionalContext ? `## Manifest Notes\n${ctx.additionalContext}\n` : ''}
Focus: auth flows, authorization checks, input validation, exposed secrets, SQL/NoSQL injection.
Return only JSON.`;
  }
}
