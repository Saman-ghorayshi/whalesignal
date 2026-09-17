#!/usr/bin/env node
// tools/d1_metrics.mjs — live D1 read/write metrics per database, last 24h.
// Run after any optimization to VERIFY the numbers moved. Needs CF_ID in .env.
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env','utf8').split('
').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim()]));
const acct = (await (await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { Authorization: 'Bearer ' + env.CF_ID } })).json()).result[0].id;
const since = new Date(Date.now() - 24*3600*1000).toISOString();
const q = ;
const r = await (await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: 'Bearer ' + env.CF_ID, 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) })).json();
const rows = r.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups;
const total = rows.reduce((s,x)=>s+(x.sum.rowsRead||0),0);
console.log('D1 reads last 24h (account-wide):', total.toLocaleString(), 'of 5,000,000 free cap');
for (const x of rows) console.log('  ', x.dimensions.databaseId.slice(0,8), (x.sum.rowsRead||0).toLocaleString(), 'read /', (x.sum.rowsWritten||0).toLocaleString(), 'written');
