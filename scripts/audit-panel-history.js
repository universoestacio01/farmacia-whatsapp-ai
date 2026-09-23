// Read-only, opt-in audit. Private extracts stay outside the project/GitHub folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dotenv = require('dotenv');

function redact(value) {
  return String(value || '')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\b\d{8,}\b/g, '[numero]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[id]');
}

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Requires --live');
  const env = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '.env')));
  const token = env.ADMIN_TOKEN?.trim();
  if (!token) throw new Error('Missing local admin credential');
  let calls = 0;
  async function get(route) {
    if (++calls > 55) throw new Error('Read request budget reached');
    const response = await fetch(`https://farmaciadeliveryraia.com/admin/api/${route}`, {
      method: 'GET', headers: { 'x-admin-token': token }, redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Admin GET failed: HTTP ${response.status}`);
    return response.json();
  }
  const conversations = await get('conversations?limit=50');
  if (!Array.isArray(conversations)) throw new Error('Unexpected conversation response');
  const report = { createdAt: new Date().toISOString(), conversations: [], failures: [], optionLists: [], logs: [], errors: null };
  const failure = /n[aã]o (?:localizei|encontrei|consegui|tenho)|indispon[ií]vel|apenas mensagens de texto|instabilidade|erro ao|sem (?:estoque|pre[cç]o)/i;
  for (const [index, conversation] of conversations.entries()) {
    const messages = await get(`conversations/${encodeURIComponent(conversation.id)}/messages?limit=100`);
    if (!Array.isArray(messages)) throw new Error('Unexpected message response');
    const alias = `C${String(index + 1).padStart(2, '0')}`;
    report.conversations.push({ alias, count: messages.length, truncated: messages.length === 100,
      start: messages[0]?.createdAt, end: messages.at(-1)?.createdAt, state: conversation.pendingAction });
    for (const [i, message] of messages.entries()) {
      const outgoing = message.direction === 'OUTBOUND';
      if (!outgoing) continue;
      if (failure.test(message.content || '')) {
        // Only short local context, not customer profiles, addresses, or full transcripts.
        const context = messages.slice(Math.max(0, i - 2), i + 2).map(m => ({
          at: m.createdAt, direction: m.direction, text: redact(m.content).slice(0, 900),
        }));
        report.failures.push({ alias, context });
      }
      if (/\b1[.)] .+[\s\S]*\b2[.)] /m.test(message.content || '')) {
        report.optionLists.push({ alias, at: message.createdAt,
          preceding: redact(messages[i - 1]?.content).slice(0, 250),
          text: redact(message.content).slice(0, 1600) });
      }
    }
  }
  const logs = await get('provider-request-logs?limit=200');
  report.logs = logs.map(l => ({ at: l.createdAt, provider: l.provider, operation: l.operation,
    query: redact(l.query), http: l.statusCode, found: l.resultsFound, filtered: l.resultsAfterFilter,
    outcome: l.outcome, reason: redact(l.failureReason), durationMs: l.durationMs }));
  const errors = await get('errors?limit=100');
  report.errors = errors.summary;
  report.calls = calls;
  report.directions = conversations.length ? 'OUTBOUND audit' : 'no conversations';
  const file = path.join(os.tmpdir(), `raia-history-audit-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ file, conversations: report.conversations, failures: report.failures.length,
    optionLists: report.optionLists.length, logCount: report.logs.length, errors: report.errors, calls }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
