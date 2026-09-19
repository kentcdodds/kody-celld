import { KodyError } from '../lib/errors.ts'
import type { JobSchedule } from '../packages/manifest.ts'

const intervalUnits: Record<string, number> = {
	s: 1000,
	sec: 1000,
	second: 1000,
	seconds: 1000,
	m: 60_000,
	min: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
	w: 604_800_000,
	week: 604_800_000,
	weeks: 604_800_000,
}

export const minimumIntervalMs = 60_000

export function parseIntervalMs(every: string) {
	const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(every)
	const unit = match?.[2]?.toLowerCase()
	const multiplier = unit ? intervalUnits[unit] : undefined
	if (!match || !multiplier) {
		throw new KodyError('invalid_schedule', `Interval "${every}" must look like "5m", "1h", "30 minutes", or "2 days".`)
	}
	const ms = Number(match[1]) * multiplier
	if (!Number.isFinite(ms) || ms < minimumIntervalMs) {
		throw new KodyError('invalid_schedule', `Interval "${every}" must be at least 1 minute.`)
	}
	return Math.round(ms)
}

type CronField = Set<number>
type ParsedCron = {
	minute: CronField
	hour: CronField
	dayOfMonth: CronField
	month: CronField
	dayOfWeek: CronField
	domWildcard: boolean
	dowWildcard: boolean
}

const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function parseCronField(
	field: string,
	min: number,
	max: number,
	names: Array<string> | null,
	expression: string,
): CronField {
	const values = new Set<number>()
	const toNumber = (token: string) => {
		const lower = token.toLowerCase()
		if (names) {
			const idx = names.indexOf(lower.slice(0, 3))
			if (idx >= 0 && lower.length <= 3) return idx + min
		}
		if (!/^\d+$/.test(token)) {
			throw new KodyError('invalid_schedule', `Cron "${expression}" has invalid token "${token}".`)
		}
		return Number(token)
	}
	for (const part of field.split(',')) {
		const [rangePart, stepPart] = part.split('/')
		const step = stepPart === undefined ? 1 : Number(stepPart)
		if (!Number.isInteger(step) || step < 1) {
			throw new KodyError('invalid_schedule', `Cron "${expression}" has invalid step "${stepPart}".`)
		}
		let start: number
		let end: number
		if (rangePart === '*' || rangePart === undefined || rangePart === '') {
			start = min
			end = max
		} else if (rangePart.includes('-')) {
			const [a, b] = rangePart.split('-')
			start = toNumber(a ?? '')
			end = toNumber(b ?? '')
			if (start > end) {
				throw new KodyError('invalid_schedule', `Cron "${expression}" range "${rangePart}" is descending.`)
			}
		} else {
			start = toNumber(rangePart)
			end = stepPart === undefined ? start : max
		}
		if (start < min || end > max) {
			throw new KodyError('invalid_schedule', `Cron "${expression}" value out of range in "${part}" (${min}-${max}).`)
		}
		for (let v = start; v <= end; v += step) values.add(v)
	}
	return values
}

export function parseCron(expression: string): ParsedCron {
	const fields = expression.trim().split(/\s+/)
	if (fields.length !== 5) {
		throw new KodyError(
			'invalid_schedule',
			`Cron "${expression}" must have 5 fields (minute hour day-of-month month day-of-week).`,
		)
	}
	const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string]
	const dayOfWeek = parseCronField(dow.replace(/(^|,)7(?=,|$|-)/g, '$10'), 0, 6, dayNames, expression)
	return {
		minute: parseCronField(minute, 0, 59, null, expression),
		hour: parseCronField(hour, 0, 23, null, expression),
		dayOfMonth: parseCronField(dom, 1, 31, null, expression),
		month: parseCronField(month, 1, 12, monthNames, expression),
		dayOfWeek,
		domWildcard: dom === '*',
		dowWildcard: dow === '*',
	}
}

type ZonedParts = { minute: number; hour: number; day: number; month: number; weekday: number }

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function zonedParts(date: Date, timezone: string): ZonedParts {
	let formatter = formatterCache.get(timezone)
	if (!formatter) {
		try {
			formatter = new Intl.DateTimeFormat('en-US', {
				timeZone: timezone,
				hourCycle: 'h23',
				minute: 'numeric',
				hour: 'numeric',
				day: 'numeric',
				month: 'numeric',
				weekday: 'short',
			})
		} catch {
			throw new KodyError('invalid_schedule', `Unknown timezone "${timezone}".`)
		}
		formatterCache.set(timezone, formatter)
	}
	const parts: Record<string, string> = {}
	for (const part of formatter.formatToParts(date)) parts[part.type] = part.value
	return {
		minute: Number(parts.minute),
		hour: Number(parts.hour) % 24,
		day: Number(parts.day),
		month: Number(parts.month),
		weekday: dayNames.indexOf((parts.weekday ?? 'sun').toLowerCase().slice(0, 3)),
	}
}

function cronMatches(cron: ParsedCron, parts: ZonedParts) {
	if (!cron.minute.has(parts.minute)) return false
	if (!cron.hour.has(parts.hour)) return false
	if (!cron.month.has(parts.month)) return false
	const domOk = cron.dayOfMonth.has(parts.day)
	const dowOk = cron.dayOfWeek.has(parts.weekday)
	if (cron.domWildcard && cron.dowWildcard) return true
	if (cron.domWildcard) return dowOk
	if (cron.dowWildcard) return domOk
	return domOk || dowOk
}

/** Next cron occurrence strictly after `after`, scanned minute by minute (max ~13 months). */
export function nextCronOccurrence(expression: string, after: Date, timezone = 'UTC') {
	const cron = parseCron(expression)
	const start = new Date(after.getTime())
	start.setUTCSeconds(0, 0)
	const limit = 60 * 24 * 400
	for (let i = 1; i <= limit; i++) {
		const candidate = new Date(start.getTime() + i * 60_000)
		if (cronMatches(cron, zonedParts(candidate, timezone))) return candidate
	}
	throw new KodyError('invalid_schedule', `Cron "${expression}" never matches within 400 days.`)
}

export function validateSchedule(schedule: JobSchedule, timezone?: string) {
	if (schedule.type === 'cron') {
		nextCronOccurrence(schedule.expression, new Date(), timezone ?? 'UTC')
	} else if (schedule.type === 'interval') {
		parseIntervalMs(schedule.every)
	} else {
		const runAt = Date.parse(schedule.runAt)
		if (Number.isNaN(runAt)) {
			throw new KodyError('invalid_schedule', `runAt "${schedule.runAt}" is not a valid date.`)
		}
	}
}

/**
 * Computes the next run after `now`. For interval schedules the anchor is the
 * previous run (or `now` when the job is new). `null` means the job is done.
 */
export function computeNextRun(
	schedule: JobSchedule,
	options: { now: Date; timezone?: string | undefined; lastRunAt?: Date | null },
): Date | null {
	const { now, timezone } = options
	switch (schedule.type) {
		case 'cron':
			return nextCronOccurrence(schedule.expression, now, timezone ?? 'UTC')
		case 'interval': {
			const every = parseIntervalMs(schedule.every)
			const anchor = options.lastRunAt ?? now
			let next = anchor.getTime() + every
			while (next <= now.getTime()) next += every
			return new Date(next)
		}
		case 'once': {
			const runAt = new Date(schedule.runAt)
			if (options.lastRunAt) return null
			return runAt.getTime() <= now.getTime() ? now : runAt
		}
	}
}
