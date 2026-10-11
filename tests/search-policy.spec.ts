import { describe, expect, it } from 'vitest'
import { Config, WEB_SEARCH_OUTPUT_BUDGET } from '../src/config.js'
import { resolveSearchStrategy } from '../src/search/index.js'

const resolveConfig = (input: unknown = {}) => Config(input as never)

describe('fixed Search API policy', () => {
  it('keeps the former default output limits without profile or depth selection', () => {
    const strategy = resolveSearchStrategy(resolveConfig())
    expect(strategy.budget).toEqual({
      maxAnswerCharacters: 6000,
      maxVisibleSources: 8,
      maxModelTextBytes: 12 * 1024,
    })
    expect(strategy.budget).toBe(WEB_SEARCH_OUTPUT_BUDGET)
    expect(Object.isFrozen(strategy.budget)).toBe(true)
    expect(strategy).not.toHaveProperty('profile')
    expect(strategy).not.toHaveProperty('depth')
    expect(strategy.prompt).toContain('Infer the best search strategy from the query.')
    expect(strategy.prompt).toContain('prefer official docs and GitHub')
    expect(strategy.prompt).toContain('verify with independent sources')
    expect(strategy.prompt).toContain('Keep the answer under 6000 characters.')
    expect(strategy.prompt).not.toContain('Search Profile')
  })

  it('keeps collection independent from the fixed visible-source limit', () => {
    const strategy = resolveSearchStrategy(resolveConfig({ retention: { providerMaxSources: 23 } }))
    expect(strategy.budget.maxVisibleSources).toBe(8)
    expect(strategy.maxCollectedSources).toBe(23)
    expect(strategy.prompt).toContain('Return at most 23 source links')
    expect(strategy.prompt).not.toContain('Return at most 8 source links')
  })
})
