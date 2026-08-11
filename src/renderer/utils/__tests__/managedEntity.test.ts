import { describe, expect, it } from 'vitest'

import { isManagedEntity } from '../managedEntity'

describe('isManagedEntity', () => {
  it('returns true when isManaged is true', () => {
    expect(isManagedEntity({ isManaged: true })).toBe(true)
  })

  it('returns false when isManaged is false', () => {
    expect(isManagedEntity({ isManaged: false })).toBe(false)
  })

  it('returns false when isManaged is absent (default case)', () => {
    expect(isManagedEntity({})).toBe(false)
  })

  it('returns false for null / undefined entities', () => {
    expect(isManagedEntity(null)).toBe(false)
    expect(isManagedEntity(undefined)).toBe(false)
  })
})
