const { execFileSync } = require('child_process');
const source = execFileSync('git', ['-C', 'E:/Projects/ThaniPitak/udonpolice-datacenter', 'show', 'origin/main:src/integrations/supabase/client.ts'], { encoding: 'utf8' });
const url = source.match(/SUPABASE_URL\s*=\s*"([^"]+)/)[1];
const key = source.match(/SUPABASE_PUBLISHABLE_KEY\s*=\s*"([^"]+)/)[1];
fetch(url + '/auth/v1/settings', { headers: { apikey: key }, signal: AbortSignal.timeout(10000) })
 .then(r => console.log(JSON.stringify({host:new URL(url).host,status:r.status})))
 .catch(e => { console.log(JSON.stringify({error:e.cause?.code || e.message}));process.exitCode=1; });
