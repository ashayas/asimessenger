// Mimics `claude -p ... --output-format stream-json` for a single one-shot request (the limits probe).
if (process.argv.includes('--fail')) { process.stderr.write('Not logged in\n'); process.exit(1) }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
out({ type: 'system', subtype: 'init', session_id: 's' })
out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 4102444800, rateLimitType: 'five_hour', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.34, resetsAt: 4102444800 }, seven_day: { utilization: 0.57, resetsAt: 4102876800 } } } })
out({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 20000, cache_creation_input_tokens: 5000 }, total_cost_usd: 0.014 })
