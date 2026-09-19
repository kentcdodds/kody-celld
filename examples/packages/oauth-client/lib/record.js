import { packageStorage } from 'kody:runtime'

const ddl =
	'CREATE TABLE IF NOT EXISTS auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, summary TEXT NOT NULL, at TEXT NOT NULL)'

export async function record(topic, summary) {
	const storage = packageStorage()
	await storage.sql(ddl)
	await storage.sql(
		'INSERT INTO auth_events (topic, summary, at) VALUES (?, ?, ?)',
		topic,
		JSON.stringify(summary),
		new Date().toISOString(),
	)
}

export async function recent(limit = 20) {
	const storage = packageStorage()
	await storage.sql(ddl)
	const { rows } = await storage.sql('SELECT id, topic, summary, at FROM auth_events ORDER BY id DESC LIMIT ?', limit)
	return rows.map((row) => ({ ...row, summary: JSON.parse(row.summary) }))
}
