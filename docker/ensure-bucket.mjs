#!/usr/bin/env node
// Creates the fleet bucket if it does not exist yet (idempotent). Used by the
// compose fleet so a fresh MinIO volume works without a manual `mc mb` step.
// Reads the same environment celld uses: CELLD_BUCKET, S3_ENDPOINT, AWS_REGION,
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY. Plain Node, no dependencies.
import { createHash, createHmac } from 'node:crypto'

const bucketUrl = process.env.CELLD_BUCKET ?? ''
const match = /^s3:\/\/([^/]+)/.exec(bucketUrl)
if (!match) {
	console.error(`ensure-bucket: CELLD_BUCKET must look like s3://bucket[/prefix] (got ${JSON.stringify(bucketUrl)})`)
	process.exit(64)
}
const bucket = match[1]
const region = process.env.AWS_REGION ?? 'us-east-1'
const accessKey = process.env.AWS_ACCESS_KEY_ID
const secretKey = process.env.AWS_SECRET_ACCESS_KEY
if (!accessKey || !secretKey) {
	console.error('ensure-bucket: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required')
	process.exit(64)
}
const endpoint = process.env.S3_ENDPOINT
	? process.env.S3_ENDPOINT.replace(/\/$/, '')
	: `https://s3.${region}.amazonaws.com`
const url = new URL(`${endpoint}/${bucket}`)

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data, encoding) => createHmac('sha256', key).update(data).digest(encoding)

function sign(method, body = '') {
	const now = new Date()
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
	const dateStamp = amzDate.slice(0, 8)
	const payloadHash = sha256(body)
	const headers = {
		host: url.host,
		'x-amz-content-sha256': payloadHash,
		'x-amz-date': amzDate,
	}
	const signedHeaders = Object.keys(headers).sort().join(';')
	const canonicalHeaders = Object.keys(headers)
		.sort()
		.map((name) => `${name}:${headers[name]}\n`)
		.join('')
	const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
	const scope = `${dateStamp}/${region}/s3/aws4_request`
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
	const kDate = hmac(`AWS4${secretKey}`, dateStamp)
	const kRegion = hmac(kDate, region)
	const kService = hmac(kRegion, 's3')
	const kSigning = hmac(kService, 'aws4_request')
	const signature = hmac(kSigning, stringToSign, 'hex')
	return {
		...headers,
		authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	}
}

async function attempt() {
	const head = await fetch(url, { method: 'HEAD', headers: sign('HEAD') })
	if (head.status === 200) return `bucket ${bucket} exists`
	if (head.status !== 404) throw new Error(`HEAD ${url} returned ${head.status}`)
	const put = await fetch(url, { method: 'PUT', headers: sign('PUT') })
	if (put.status === 200 || put.status === 409) return `bucket ${bucket} created`
	throw new Error(`PUT ${url} returned ${put.status}: ${(await put.text()).slice(0, 300)}`)
}

const deadline = Date.now() + Number(process.env.ENSURE_BUCKET_TIMEOUT_MS ?? 60_000)
for (;;) {
	try {
		console.log(`ensure-bucket: ${await attempt()} at ${endpoint}`)
		break
	} catch (error) {
		if (Date.now() > deadline) {
			console.error(`ensure-bucket: giving up: ${error instanceof Error ? error.message : String(error)}`)
			process.exit(1)
		}
		console.log(`ensure-bucket: waiting for object store (${error instanceof Error ? error.message : String(error)})`)
		await new Promise((resolve) => setTimeout(resolve, 2_000))
	}
}
