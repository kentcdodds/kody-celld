import { record } from './lib/record.js'

// inputMode "params": the JSON body (or its `params` member) is the argument.
export default async function plain(params) {
	await record('webhook:plain', params)
	if (params.fail) throw new Error(`plain webhook asked to fail: ${params.fail}`)
	return { echoed: params, keys: Object.keys(params).sort() }
}
