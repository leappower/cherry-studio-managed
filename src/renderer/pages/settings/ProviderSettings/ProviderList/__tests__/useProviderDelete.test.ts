import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProviderDelete } from '../useProviderDelete'

const useProviderActionsMock = vi.fn()

vi.mock('@renderer/hooks/useProvider', () => ({
  useProviderActions: (...args: any[]) => useProviderActionsMock(...args)
}))

const deleteProviderByIdMock = vi.fn()
const provider = { id: 'openai' } as any

describe('useProviderDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteProviderByIdMock.mockResolvedValue(undefined)
    useProviderActionsMock.mockReturnValue({
      deleteProviderById: deleteProviderByIdMock
    })
  })

  it('calls deleteProviderById (the logo lives on the row and is deleted with it)', async () => {
    const { result } = renderHook(() => useProviderDelete())

    await act(async () => {
      await result.current.deleteProvider(provider)
    })

    expect(deleteProviderByIdMock).toHaveBeenCalledWith('openai')
  })

  it('does not delete a managed provider (F-10 double-safety guard)', async () => {
    const { result } = renderHook(() => useProviderDelete())

    await act(async () => {
      await result.current.deleteProvider({ id: 'managed-provider', isManaged: true } as any)
    })

    expect(deleteProviderByIdMock).not.toHaveBeenCalled()
  })
})
