/**
 * ManagedRegistryService — generalized managed-entity protection (F-8).
 *
 * Replaces the hard-coded `cherryai` special-case in ProviderService with a
 * registry-driven `isManaged(kind, id)` decision backed by an independent
 * `managed_registry.db` (SQLite) co-located with the main database in
 * `{userData}/Data/`.
 *
 * Ownership model (v4.0): the managed registry is written ONLY by the Sidecar
 * process. This Fork layer is a read-only consumer. In M1 there is no Sidecar
 * writer, so this service owns the *seed initialization path* only: when the
 * db file does not exist it is created with the canonical `cherryai` provider
 * seed. Once present it is treated as read-only.
 *
 * Robustness: an embedded default seed keeps `cherryai` managed even when the
 * db is missing or cannot be opened (e.g. fresh install, restricted test
 * environment, corrupt file). The independent db is an *additive* source of
 * extra managed entries. This guarantees the existing CherryAI protection
 * never regresses.
 */

import { application } from '@application'
import { loggerService } from '@logger'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

const logger = loggerService.withContext('ManagedRegistryService')

export type ManagedKind = 'provider' | 'agent'

/**
 * Canonical embedded seed. The `cherryai` provider is always managed — this is
 * the hard fallback that preserves current behavior whether or not the
 * independent db exists (tests, fresh install, Sidecar never ran).
 */
const EMBEDDED_DEFAULT_MANAGED: Record<ManagedKind, readonly string[]> = {
  provider: ['cherryai'],
  agent: []
}

const MANAGED_REGISTRY_DB_NAME = 'managed_registry.db'

class ManagedRegistryService {
  private db: Database.Database | null = null
  private dbLoaded = false

  /**
   * Extra managed entries read from the independent db. Only ever augmented by
   * the Sidecar (M2+); the embedded default set is always authoritative.
   */
  private extraManaged: Record<ManagedKind, Set<string>> = {
    provider: new Set<string>(),
    agent: new Set<string>()
  }

  /**
   * Lazily open (or seed-initialize) the independent managed_registry.db.
   *
   * Safe to call at any time: resolving the path or opening the db may fail in
   * restricted environments (e.g. unit tests without an initialised path
   * registry), so every failure path degrades gracefully to the embedded
   * defaults. This guarantees `isManaged('provider', 'cherryai')` is always
   * true regardless of db state.
   */
  private ensureDbLoaded(): void {
    if (this.dbLoaded) return
    this.dbLoaded = true

    let dbPath: string
    try {
      dbPath = path.join(application.getPath('app.userdata.data'), MANAGED_REGISTRY_DB_NAME)
    } catch (error) {
      logger.warn('managed_registry path unavailable; using embedded defaults only', error as Error)
      return
    }

    try {
      const dbExists = fs.existsSync(dbPath)
      if (!dbExists) {
        // M1 seed-initialization path (no Sidecar writer yet). Create the db with
        // the canonical cherryai seed so future Sidecar writes have a base file.
        this.createAndSeedDb(dbPath)
        return
      }

      this.db = new Database(dbPath, { readonly: true })
      this.readManagedEntries()
    } catch (error) {
      // Non-fatal: any open/read failure falls back to the embedded default set.
      logger.warn('managed_registry open/read failed; using embedded defaults only', error as Error)
      this.closeDb()
    }
  }

  private createAndSeedDb(dbPath: string): void {
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS managed_entity (
          kind TEXT NOT NULL,
          id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (kind, id)
        );
      `)
      const insert = db.prepare('INSERT OR IGNORE INTO managed_entity (kind, id, created_at) VALUES (?, ?, ?)')
      for (const providerId of EMBEDDED_DEFAULT_MANAGED.provider) {
        insert.run('provider', providerId, Date.now())
      }
      for (const agentId of EMBEDDED_DEFAULT_MANAGED.agent) {
        insert.run('agent', agentId, Date.now())
      }
      logger.info('Seeded managed_registry.db with canonical defaults', { dbPath })
    } finally {
      db.close()
    }
  }

  private readManagedEntries(): void {
    if (!this.db) return
    const rows = this.db.prepare('SELECT kind, id FROM managed_entity').all() as Array<{
      kind: string
      id: string
    }>
    const next: Record<ManagedKind, Set<string>> = {
      provider: new Set<string>(),
      agent: new Set<string>()
    }
    for (const row of rows) {
      if (row.kind === 'provider' || row.kind === 'agent') {
        next[row.kind].add(row.id)
      }
    }
    this.extraManaged = next
  }

  private closeDb(): void {
    try {
      this.db?.close()
    } catch {
      // best-effort close
    }
    this.db = null
  }

  /** Managed provider ids: embedded defaults ∪ independent db. */
  getManagedProviders(): string[] {
    this.ensureDbLoaded()
    return [...new Set([...EMBEDDED_DEFAULT_MANAGED.provider, ...this.extraManaged.provider])]
  }

  /** Managed agent ids: embedded defaults ∪ independent db. */
  getManagedAgents(): string[] {
    this.ensureDbLoaded()
    return [...new Set([...EMBEDDED_DEFAULT_MANAGED.agent, ...this.extraManaged.agent])]
  }

  /**
   * Whether the entity with the given kind + id is managed (i.e. immutable by
   * the user). Managed entities reject create/update/delete/move mutations.
   */
  isManaged(kind: ManagedKind, id: string): boolean {
    this.ensureDbLoaded()
    return EMBEDDED_DEFAULT_MANAGED[kind].includes(id) || this.extraManaged[kind].has(id)
  }
}

export const managedRegistryService = new ManagedRegistryService()
