// Picks the Supabase layer when the VITE_ env vars are set, else the mock (demo) layer.
const supabaseModule = import.meta.glob('./supabase.js');
export async function createDataLayer() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (url && key) {
    const load = supabaseModule['./supabase.js'];
    if (!load) throw new Error('src/data/supabase.js is missing');
    const [{ createClient }, mod] = await Promise.all([import('@supabase/supabase-js'), load()]);
    const client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    return mod.createSupabaseDataLayer({ client });
  }
  const { createMockDataLayer } = await import('./mock.js');
  return createMockDataLayer({ storage: window.localStorage });
}
