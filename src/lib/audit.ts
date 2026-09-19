import type { AuditEntry } from '../cells/registry-cell.ts'
import type { Env } from '../env.ts'

/**
 * Appends to the fleet-wide audit log in the registry cell. Callers pass
 * names and ids only; the log must never receive secret values or tokens.
 */
export function recordAudit(env: Env, entry: Omit<AuditEntry, 'id' | 'at'>) {
	return env.REGISTRY.getByName('registry').auditAppend(entry)
}
