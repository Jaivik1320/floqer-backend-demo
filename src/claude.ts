// ============================================================================
//  CLAUDE — writes the personalised outreach email for one lead.
//  If ANTHROPIC_API_KEY is set, this makes a REAL API call to Claude.
//  If it's missing or the call fails, we fall back to a templated message so
//  the pipeline never breaks. The Message row records which path was used
//  (`generatedBy`), so provenance is honest and visible.
//
//  Graceful degradation like this is a real backend pattern — worth pointing
//  to in the interview: the system stays up even when a dependency is down.
// ============================================================================
import Anthropic from '@anthropic-ai/sdk';

export interface LeadForMessage {
  companyName: string;
  fundingStage: string;
  techStack: string[];
  hiringSignal: boolean;
}

export interface GeneratedMessage {
  subject: string;
  body: string;
  generatedBy: 'claude' | 'template-fallback';
}

const apiKey = process.env.ANTHROPIC_API_KEY;
const client = apiKey ? new Anthropic({ apiKey }) : null;

export async function writeOutreach(lead: LeadForMessage): Promise<GeneratedMessage> {
  const context =
    `Company: ${lead.companyName}\n` +
    `Funding: ${lead.fundingStage}\n` +
    `Tech stack: ${lead.techStack.join(', ')}\n` +
    `Signal: ${lead.hiringSignal ? 'hiring GTM/RevOps roles' : 'no active hiring signal'}`;

  // ---- Real Claude call --------------------------------------------------
  if (client) {
    try {
      const res = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        system:
          'You write short, direct B2B sales outreach for Floqer, a GTM data ' +
          'automation platform. 3-4 sentences. No fluff. Reference the specific ' +
          'signal and tech stack. Return JSON only: {"subject": "...", "body": "..."}.',
        messages: [{ role: 'user', content: `Write outreach for this lead:\n${context}` }],
      });
      const text = res.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('');
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return { subject: parsed.subject, body: parsed.body, generatedBy: 'claude' };
    } catch (err) {
      // fall through to template on any error (bad key, rate limit, parse fail)
      console.warn('Claude call failed, using template fallback:', (err as Error).message);
    }
  }

  // ---- Templated fallback ------------------------------------------------
  return {
    subject: `${lead.companyName}: your GTM stack at ${lead.fundingStage}`,
    body:
      `Hi there,\n\nNoticed ${lead.companyName} is ${lead.hiringSignal ? 'hiring GTM roles' : 'scaling its GTM motion'} ` +
      `while running ${lead.techStack.slice(0, 2).join(' + ')}. Teams at your stage usually spend 15+ hours a week ` +
      `stitching those tools together. Floqer replaces that with one automated pipeline — enrichment, scoring, and ` +
      `outreach, continuously. Worth 15 minutes?`,
    generatedBy: 'template-fallback',
  };
}
