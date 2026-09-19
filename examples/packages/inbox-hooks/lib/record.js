import { packageStorage } from 'kody:runtime'

export async function record(kind, summary) {
	const storage = packageStorage()
	await storage.sql(
		'CREATE TABLE IF NOT EXISTS inbound (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, summary TEXT NOT NULL, at TEXT NOT NULL)',
	)
	await storage.sql(
		'INSERT INTO inbound (kind, summary, at) VALUES (?, ?, ?)',
		kind,
		JSON.stringify(summary),
		new Date().toISOString(),
	)
}

export async function recent(limit = 20) {
	const storage = packageStorage()
	await storage.sql(
		'CREATE TABLE IF NOT EXISTS inbound (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, summary TEXT NOT NULL, at TEXT NOT NULL)',
	)
	const { rows } = await storage.sql('SELECT id, kind, summary, at FROM inbound ORDER BY id DESC LIMIT ?', limit)
	return rows.map((row) => ({ ...row, summary: JSON.parse(row.summary) }))
}
