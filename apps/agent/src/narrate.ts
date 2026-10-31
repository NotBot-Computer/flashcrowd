// Optional narration for the demo: Claude turns an agent's log line into one plain sentence. It only describes what
// the code already did. Nothing it returns reaches an amount, a signature or a decision, the agents never wait for it,
// and when it fails or is slow the step simply goes unnarrated. Off unless AGENT_NARRATE=1.
import Anthropic from '@anthropic-ai/sdk'
import type { AgentStep } from './flow'

export const NARRATE_MODEL = 'claude-opus-5-5'
const TIMEOUT_MS = 15_000

/** The steps worth a sentence, each narrated once per run. */
export const NARRATED_STEPS: AgentStep[] = [
  'search',
  'match',
  'evaluate',
  'fund',
  'settle',
  'decrypt',
  'refund',
  'refuse',
]

const SYSTEM = `You narrate a live demo of FlashCrowd on the BSV blockchain. Autonomous AI agents pool their money to \
buy one dataset none of them can afford alone. Each agent locks its share in its own on-chain hash-time-locked \
output; the seller is paid only by revealing the decryption key on chain, and if the seller does not deliver, every \
agent takes its money back. Amounts and signatures are decided by the agents' code under a spend policy.

You get one log line from an agent. Write one plain-English sentence of at most 30 words saying what just happened \
and why it matters to the audience. Use only facts in the line: no new numbers, names, links or outcomes. Plain \
text only, no markdown or quotation marks.`

/** One log line in, one sentence out; undefined when there is nothing to say. */
export type Complete = (line: string) => Promise<string | undefined>

/** A Complete backed by the Claude API. Opus and Sonnet get the server-side refusal fallback; Haiku has none. */
export function claudeComplete(client: Anthropic, model = NARRATE_MODEL): Complete {
  const withFallback = !model.startsWith('claude-haiku')
  return async (line) => {
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: 2000,
        system: SYSTEM,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: line }],
        ...(withFallback && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
      },
      { timeout: TIMEOUT_MS, maxRetries: 0 },
    )
    if (response.stop_reason === 'refusal') return undefined
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join(' ')
      .trim()
    return text === '' ? undefined : text
  }
}

/**
 * Narrates each step in NARRATED_STEPS once. Never throws and never makes an agent wait. The model calls run at the
 * same time, but the sentences print in the order their steps happened, each with its step.
 */
export class Narrator {
  private readonly seen = new Set<AgentStep>()
  private printed: Promise<void> = Promise.resolve()
  private failed = false

  /** `onError` hears about the first failure only (no credentials, rate limit…), so the terminal says why once. */
  constructor(
    private readonly complete: Complete,
    private readonly print: (sentence: string, step: AgentStep) => void,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  /** Called for every log line; returns at once. */
  step(step: AgentStep, line: string): void {
    if (!NARRATED_STEPS.includes(step) || this.seen.has(step)) return
    this.seen.add(step)
    const sentence = this.complete(line).catch((error: unknown) => {
      if (!this.failed) {
        this.failed = true
        this.onError(error)
      }
      return undefined
    })
    this.printed = this.printed.then(async () => {
      const text = await sentence
      if (text !== undefined) this.print(text, step)
    })
  }

  /** Waits for sentences still on their way, so they print before the summary. */
  async flush(): Promise<void> {
    await this.printed
  }
}

/**
 * The narrator the command line uses: undefined unless AGENT_NARRATE=1. The model is AGENT_NARRATE_MODEL or
 * NARRATE_MODEL; credentials are the SDK's (ANTHROPIC_API_KEY, or an `ant auth login` profile).
 */
export function narratorFromEnv(
  env: Record<string, string | undefined>,
  print: (sentence: string, step: AgentStep) => void,
  onError?: (error: unknown) => void,
): { narrator: Narrator; model: string } | { narrator: undefined; reason: string } {
  if (env.AGENT_NARRATE !== '1') return { narrator: undefined, reason: 'off (set AGENT_NARRATE=1)' }
  const model = env.AGENT_NARRATE_MODEL || NARRATE_MODEL
  let client: Anthropic
  try {
    client = new Anthropic()
  } catch (e) {
    return { narrator: undefined, reason: `off: ${(e as Error).message}` }
  }
  return { narrator: new Narrator(claudeComplete(client, model), print, onError), model }
}
