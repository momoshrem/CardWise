/* CardWise reminders: runs on GitHub. Reads your gist, and at the time you picked in the app,
   sends a push notification to each phone that turned reminders on. Nothing here stores your data elsewhere.
   GitHub starts scheduled runs late or skips them, so a run that starts before the reminder time on a day with
   reminders waits and sends right on time. One run may wait up to MAX_WAIT minutes (GitHub stops a run after
   6 hours); if the time is further away, it waits that long and then starts a fresh run of itself to carry on. */
const GIST = process.env.GIST_ID, TOKEN = process.env.GIST_TOKEN;
const STATE_FILE = 'reminders-sent.json';
const DAYS_OK = [0, 1, 2, 3, 4, 5, 6, 7];   // the day of, or 1 to 7 days before (matches the app)
const MAX_WAIT = +process.env.MAX_WAIT_MIN || 330;
/* the clock: real time, or a test time that moves forward when a test "waits" */
let skew = 0;
const clock = () => (process.env.NOW ? Date.parse(process.env.NOW) : Date.now()) + skew;
const sleep = ms => process.env.FAKE_SLEEP ? (skew += ms, Promise.resolve()) : new Promise(r => setTimeout(r, ms));
const hm = ms => { const m = Math.round(ms / 6e4); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

/* the date and hour right now in the time zone saved by the app */
function localNow(tz, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month - 1, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, key: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` };
}
/* same rule as the app: the next date with this day of the month (today counts); day 31 becomes the last day of short months */
const clamp = (y, m, day) => new Date(Date.UTC(y, m, Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())));
function nextDate(day, t) {
  const today = Date.UTC(t.y, t.m, t.d);
  for (let o = 0; o < 3; o++) { const d = clamp(t.y, t.m + o, day); if (+d >= today) return { d, days: Math.round((+d - today) / 864e5) }; }
}
const when = n => n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;

/* what to send today: one notification per card and event.
   iPhone: the card name as the title (it shows one title line) and the reminder as the text under it.
   Android: the card name, then the reminder on its own line, both in the title. */
function remindersFor(settings, cards, t) {
  const out = [], name = c => c.name || (c.last4 ? 'Card ending ' + c.last4 : 'Card');
  const want = (on, days) => on !== false ? (Array.isArray(days) ? days.map(Number).filter(x => DAYS_OK.includes(x)) : []) : [];
  const payDays = want(settings.pay, settings.payDays || [0, 2]), stmtDays = want(settings.stmt, settings.stmtDays || [1]);
  (cards || []).forEach(c => {
    if (+c.dueDay > 0) { const n = nextDate(+c.dueDay, t); if (n && payDays.includes(n.days))
      out.push({ title: name(c), body: `Payment due ${when(n.days)}`, android: `${name(c)}\nPayment due ${when(n.days)}`, tag: `p-${c.id}-${n.d.toISOString().slice(0, 10)}-${n.days}` }); }
    if (+c.stmtDay > 0) { const n = nextDate(+c.stmtDay, t); if (n && stmtDays.includes(n.days))
      out.push({ title: name(c), body: `Statement closes ${when(n.days)}`, android: `${name(c)}\nStatement closes ${when(n.days)}`, tag: `s-${c.id}-${n.d.toISOString().slice(0, 10)}-${n.days}` }); }
  });
  return out;
}

async function gh(path, opt = {}) {
  const r = await fetch('https://api.github.com' + path, Object.assign({}, opt, { headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } }));
  if (!r.ok) throw new Error(`GitHub ${r.status} on ${path}`);
  return r.json();
}
/* which reminders still need sending today: each one is remembered once sent, so a late run still sends,
   a settings change during the day isn't blocked, and nothing goes out twice. Old entries are dropped after a week. */
function pending(list, state, dayKey, nowMs) {
  const sent = Object.assign({}, (state && state.sent) || {});
  Object.keys(sent).forEach(k => { if (nowMs - Date.parse(sent[k]) > 7 * 864e5) delete sent[k]; });
  const todo = list.filter(n => !sent[n.tag + '@' + dayKey]);
  return { todo, mark: n => { sent[n.tag + '@' + dayKey] = new Date(nowMs).toISOString(); }, sent };
}
async function fileText(f) { return f.truncated ? (await fetch(f.raw_url)).text() : f.content; }

/* start a fresh run of this workflow (GitHub's own token for this repo; nothing else gets access) */
async function relay() {
  if (process.env.DRY_RUN || !process.env.GH_TOKEN) return console.log('Would start a new run to keep waiting.');
  const r = await fetch(`https://api.github.com/repos/${process.env.REPO}/actions/workflows/reminders.yml/dispatches`, {
    method: 'POST', headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + process.env.GH_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: process.env.REF || 'main', inputs: { test: 'false' } }) });
  console.log(r.ok ? 'Started a new run to keep waiting.' : `Could not start a new run (${r.status}); the next scheduled run takes over.`);
}

async function main() {
  const webpush = require('web-push');
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://momoshrem.github.io/CardWise/', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
  const test = process.env.TEST === 'true';
  for (;;) {
    /* read the gist fresh each time round, so changes made in the app while waiting are used */
    const g = process.env.LOCAL_GIST ? JSON.parse(require('fs').readFileSync(process.env.LOCAL_GIST, 'utf8')) : await gh('/gists/' + GIST);
    const read = async n => g.files[n] ? JSON.parse(await fileText(g.files[n]) || 'null') : null;
    const ex = (await read('expenses.json')) || {}, cd = (await read('cards.json')) || {}, state = (await read(STATE_FILE)) || {};
    const settings = ex.reminders || {}, phones = (ex.devices || []).filter(d => d.on && d.sub && d.sub.endpoint);
    if (!phones.length) return console.log('No phone has reminders turned on.');
    const nowMs = clock(), t = localNow(settings.tz || 'America/New_York', new Date(nowMs));
    let list, track = null;
    if (test) list = [{ title: 'CardWise reminders are on', body: '', tag: 'test' }];
    else {
      const hour = Number.isFinite(+settings.hour) ? +settings.hour : 9;
      const all = remindersFor(settings, cd.cards, t);
      track = pending(all, state, t.key, nowMs); list = track.todo;
      if (!list.length) return console.log(all.length ? 'Today\'s reminders were already sent.' : 'Nothing to remind about today.');
      if (t.h < hour) {
        const ms = ((hour - t.h) * 3600 - t.mi * 60 - t.s) * 1000;
        if (ms <= MAX_WAIT * 6e4) { console.log(`${list.length} reminder(s) today. Waiting until ${hour}:00 to send (${hm(ms)}).`); await sleep(ms + 2000); continue; }
        console.log(`${list.length} reminder(s) today at ${hour}:00, ${hm(ms)} away. Waiting ${hm(MAX_WAIT * 6e4)}, then handing over to a new run.`);
        await sleep(MAX_WAIT * 6e4); return relay();
      }
    }
    console.log(`${list.length} reminder(s) for ${phones.length} phone(s).`);
    for (const n of list) {
      for (const p of phones) {
        const apple = /push\.apple\.com/.test(p.sub.endpoint), msg = apple || !n.android ? { title: n.title, body: n.body || '', tag: n.tag } : { title: n.android, body: '', tag: n.tag };
        if (process.env.DRY_RUN) { console.log('WOULD SEND', p.label || p.id, '|', JSON.stringify(msg.title), '|', JSON.stringify(msg.body), '| at', new Date(clock()).toISOString()); continue; }
        try { await webpush.sendNotification(p.sub, JSON.stringify(msg), { TTL: 12 * 3600, urgency: 'normal' }); console.log('Sent:', n.title, '->', p.label || 'phone'); }
        catch (e) { console.log(`Could not reach ${p.label || 'a phone'} (${e.statusCode || e.message}).${e.statusCode === 404 || e.statusCode === 410 ? ' Turn reminders off and on again on that phone.' : ''}`); }
      }
      if (track) track.mark(n);
    }
    if (track && !process.env.DRY_RUN && !process.env.LOCAL_GIST)
      await gh('/gists/' + GIST, { method: 'PATCH', body: JSON.stringify({ files: { [STATE_FILE]: { content: JSON.stringify({ sent: track.sent }) } } }) });
    return;
  }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { remindersFor, localNow, nextDate, pending };
