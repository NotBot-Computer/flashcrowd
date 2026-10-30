// Narration: which steps get a sentence, what is sent to Claude, and that failures never reach the agents. No call
// goes to the Claude API: the client is a fake.
import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { claudeComplete, NARRATE_MODEL, narratorFromEnv, Narrator } from '../src/narrate'

describe('Narrator', () => {
  it('narrates each listed step once and skips the rest', async () => {
    const asked: string[] = []
    const printed: string[] = []
    const narrator = new Narrator(
      async (line) => {
        asked.push(line)
        return `sentence about ${line}`
      },
      (s) => printed.push(s),
    )
    narrator.step('search', 'agent-1: wants the dataset')
    narrator.step('search', 'agent-2: wants the dataset')
    narrator.step('intent', 'agent-1: intent published')
    narrator.step('authorize', 'agent-1: authorized 4000 sats')
    narrator.step('fund', 'agent-2: locked 4000 sats')
    await narrator.flush()
    expect(asked).toEqual(['agent-1: wants the dataset', 'agent-2: locked 4000 sats'])
    expect(printed).toEqual([
      'sentence about agent-1: wants the dataset',
      'sentence about agent-2: locked 4000 sats',
    ])
  })

  it('stays quiet when the model fails or has nothing to say, and never throws', async () => {
    const printed: string[] = []
    const narrator = new Narrator(
      async (line) => {
        if (line.includes('fail')) throw new Error('rate limited')
        return undefined
      },
      (s) => printed.push(s),
    )
    expect(() => narrator.step('fund', 'fail')).not.toThrow()
    narrator.step('decrypt', 'agent-1: decrypted 157 bytes')
    await narrator.flush()
    expect(printed).toEqual([])
  })

  it('reports only the first failure', async () => {
    const errors: unknown[] = []
    const narrator = new Narrator(
      async () => {
        throw new Error('no credentials')
      },
      () => undefined,
      (e) => errors.push(e),
    )
    narrator.step('search', 'a')
    narrator.step('fund', 'b')
    narrator.step('decrypt', 'c')
    await narrator.flush()
    expect(errors.map((e) => (e as Error).message)).toEqual(['no credentials'])
  })

  it('does not make the caller wait for the model', async () => {
    let release: () => void = () => undefined
    const narrator = new Narrator(
      () => new Promise((resolve) => (release = () => resolve('late sentence'))),
      () => undefined,
    )
    const started = Date.now()
    narrator.step('fund', 'agent-1: locked 4000 sats')
    expect(Date.now() - started).toBeLessThan(50)
    release()
    await narrator.flush()
  })
})

describe('claudeComplete', () => {
  /** A fake client that records each request and answers with `reply`. */
  function fakeClient(reply: Partial<Anthropic.Beta.BetaMessage>) {
    const requests: { params: Record<string, unknown>; options: Record<string, unknown> }[] = []
    const client = {
      beta: {
        messages: {
          create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
            requests.push({ params, options })
            return { stop_reason: 'end_turn', content: [], ...reply }
          },
        },
      },
    } as unknown as Anthropic
    return { client, requests }
  }

  it('sends one line to Opus 5.5 at low effort with the refusal fallback, and returns the text', async () => {
    const { client, requests } = fakeClient({
      content: [{ type: 'text', text: ' Agent 1 locked its share on chain. ', citations: null }],
    } as Partial<Anthropic.Beta.BetaMessage>)
    const sentence = await claudeComplete(client)('agent-1: locked 4000 sats')
    expect(sentence).toBe('Agent 1 locked its share on chain.')
    const { params, options } = requests[0]
    expect(params).toMatchObject({
      model: NARRATE_MODEL,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'agent-1: locked 4000 sats' }],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
    expect(params).not.toHaveProperty('tools')
    expect(options).toMatchObject({ maxRetries: 0 })
  })

  it('leaves the fallback out for Haiku, which has none', async () => {
    const { client, requests } = fakeClient({
      content: [{ type: 'text', text: 'ok', citations: null }],
    } as Partial<Anthropic.Beta.BetaMessage>)
    await claudeComplete(client, 'claude-haiku-5-5')('agent-1: decrypted 157 bytes')
    expect(requests[0].params.model).toBe('claude-haiku-5-5')
    expect(requests[0].params).not.toHaveProperty('fallbacks')
    expect(requests[0].params).not.toHaveProperty('betas')
  })

  it('returns nothing for a refusal or an empty answer', async () => {
    const refused = fakeClient({ stop_reason: 'refusal' } as Partial<Anthropic.Beta.BetaMessage>)
    expect(await claudeComplete(refused.client)('x')).toBeUndefined()
    const empty = fakeClient({ content: [] })
    expect(await claudeComplete(empty.client)('x')).toBeUndefined()
  })
})

describe('narratorFromEnv', () => {
  it('is off unless AGENT_NARRATE=1', () => {
    expect(narratorFromEnv({}, () => undefined)).toMatchObject({ narrator: undefined, reason: /off/ })
    expect(narratorFromEnv({ AGENT_NARRATE: '0' }, () => undefined).narrator).toBeUndefined()
  })

  it('uses Opus 5.5 by default and AGENT_NARRATE_MODEL when set', () => {
    const saved = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key-not-used'
    try {
      expect(narratorFromEnv({ AGENT_NARRATE: '1' }, () => undefined)).toMatchObject({ model: NARRATE_MODEL })
      expect(
        narratorFromEnv({ AGENT_NARRATE: '1', AGENT_NARRATE_MODEL: 'claude-haiku-5-5' }, () => undefined),
      ).toMatchObject({ model: 'claude-haiku-5-5' })
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved
    }
  })
})
