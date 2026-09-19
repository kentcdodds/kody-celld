import { record } from './record.js'

// Subscription handler for email.message.received: { topic, message }.
export default async function onEmail({ topic, message }) {
	await record('email', { topic, id: message.id, subject: message.subject, from: message.from })
	return { filed: message.id }
}
