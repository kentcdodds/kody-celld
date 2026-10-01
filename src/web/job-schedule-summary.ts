export type JobScheduleSummaryInput =
	{ type: 'cron'; expression: string } | { type: 'interval'; every: string } | { type: 'once'; runAt: string }

export function summarizeJobSchedule(schedule: JobScheduleSummaryInput) {
	switch (schedule.type) {
		case 'cron':
			return schedule.expression
		case 'interval':
			return `every ${schedule.every}`
		case 'once':
			return `once at ${schedule.runAt}`
	}
}
