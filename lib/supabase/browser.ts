import { createBrowserClient } from "@supabase/ssr";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { SupabaseClient } from "@supabase/supabase-js";

// Module-level singleton — avoids creating multiple WebSocket connections
// across re-renders. Only used in "use client" components.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: SupabaseClient<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getBrowserClient(): SupabaseClient<any> {
  if (_client) return _client;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  ) as SupabaseClient<any>;

  return _client;
}
