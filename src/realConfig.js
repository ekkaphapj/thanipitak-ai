// Public Supabase client configuration from udonpolice-datacenter origin/main b1303e2.
// This is an anon key, never a service-role credential. Reads still require user JWTs.
module.exports = {
 url: process.env.REAL_SUPABASE_URL || 'https://apnppxsxwlfnttzmjtgk.supabase.co',
 key: process.env.REAL_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwbnBweHN4d2xmbnR0em1qdGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQyNTYxODgsImV4cCI6MjA3OTgzMjE4OH0.3sFpRpfkD2tIX2MTIxD1jLta4iGwRO7BuSohdEOgMz8',
};
