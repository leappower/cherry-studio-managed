/**
 * Managed-entity helpers (F-10).
 *
 * A managed entity (provider / agent) is immutable by the user: the UI hides
 * delete and disables edit (read-only), and the server independently rejects
 * create/update/delete mutations as the safety backstop (F-8). This module is
 * the renderer-side read of the `isManaged` flag injected main-side from the
 * managed registry. It keeps all managed-entity decisions in one place so the
 * ProviderSettings / Agent UI lock down consistently.
 */

/** An entity that can report whether it is managed. */
export interface ManagedEntity {
  isManaged?: boolean
}

/**
 * Whether the given entity is managed (i.e. immutable by the user). Absent or
 * `false` ⇒ not managed — the normal case, so non-managed providers/agents are
 * unaffected. Central predicate so list and form code agree on one definition.
 */
export function isManagedEntity(entity: ManagedEntity | null | undefined): boolean {
  return entity?.isManaged === true
}
