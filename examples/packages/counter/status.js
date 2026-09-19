import { packageStorage } from 'kody:runtime'

export default async function status() {
	const storage = packageStorage()
	const count = (await storage.get('count')) ?? 0
	const ticks = (await storage.get('ticks')) ?? 0
	const events = await storage.sql(
		'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, at TEXT NOT NULL)',
	)
	const totals = await storage.sql('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY kind')
	return { id: storage.id, count, ticks, events: totals.rows, tableCreated: events.rowsWritten >= 0 }
}
