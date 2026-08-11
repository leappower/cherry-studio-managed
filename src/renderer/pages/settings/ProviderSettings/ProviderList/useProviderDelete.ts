import { useProviderActions } from '@renderer/hooks/useProvider'
import { isManagedEntity } from '@renderer/utils/managedEntity'
import type { Provider } from '@shared/data/types/provider'
import { useCallback } from 'react'

export function useProviderDelete() {
  const { deleteProviderById } = useProviderActions()

  // The custom logo lives on the provider row, so it is removed together with
  // the provider — no separate logo cleanup needed.
  const deleteProvider = useCallback(
    async (provider: Provider) => {
      // Defensive guard (F-10): a managed provider must never be deleted from the
      // renderer, even if a delete entry point is somehow reached. The server
      // independently rejects it too (F-8), but we don't even send the request.
      if (isManagedEntity(provider)) {
        return
      }
      await deleteProviderById(provider.id)
    },
    [deleteProviderById]
  )

  return { deleteProvider }
}
