import { packageStorage } from 'kody:runtime'

export async function recordEvent(kind) {
	const storage = packageStorage()
	await storage.sql(
		'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, at TEXT NOT NULL)',
	)
	await storage.sql('INSERT INTO events (kind, at) VALUES (?, ?)', kind, new Date().toISOString())
}
