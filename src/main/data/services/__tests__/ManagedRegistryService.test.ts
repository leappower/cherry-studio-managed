import { managedRegistryService } from '@data/services/ManagedRegistryService'

describe('ManagedRegistryService', () => {
  afterEach(() => {
    // Reset test-injected extra entries so tests stay isolated.

    ;(managedRegistryService as unknown as { extraManaged: Record<string, Set<string>> }).extraManaged = {
      provider: new Set<string>(),
      agent: new Set<string>()
    }
  })

  it('embeds the canonical cherryai provider as managed (fallback seed)', () => {
    expect(managedRegistryService.isManaged('provider', 'cherryai')).toBe(true)
  })

  it('returns cherryai in getManagedProviders()', () => {
    expect(managedRegistryService.getManagedProviders()).toContain('cherryai')
  })

  it('has no managed agents by default', () => {
    expect(managedRegistryService.getManagedAgents()).toEqual([])
    expect(managedRegistryService.isManaged('agent', 'any-agent')).toBe(false)
  })

  it('treats non-managed provider ids as unmanaged', () => {
    expect(managedRegistryService.isManaged('provider', 'openai')).toBe(false)
    expect(managedRegistryService.isManaged('provider', 'anthropic')).toBe(false)
  })

  it('isManaged honors extra registered entries (custom managed entities)', () => {
    managedRegistryService._registerManagedForTest('provider', 'custom-managed-provider')
    managedRegistryService._registerManagedForTest('agent', 'custom-managed-agent')

    expect(managedRegistryService.isManaged('provider', 'custom-managed-provider')).toBe(true)
    expect(managedRegistryService.isManaged('agent', 'custom-managed-agent')).toBe(true)
    expect(managedRegistryService.getManagedProviders()).toContain('custom-managed-provider')
    expect(managedRegistryService.getManagedAgents()).toContain('custom-managed-agent')
  })

  it('keeps cherryai managed even after extra entries are registered', () => {
    managedRegistryService._registerManagedForTest('provider', 'custom-managed-provider')
    expect(managedRegistryService.isManaged('provider', 'cherryai')).toBe(true)
  })
})
