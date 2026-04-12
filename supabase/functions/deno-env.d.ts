/**
 * Supabase Edge Functions 在 Deno 中运行；本文件仅为 IDE / `tsc -p` 提供类型，不参与 Expo 打包。
 *
 * @see https://supabase.com/docs/guides/functions
 */

declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

declare module 'https://esm.sh/@supabase/supabase-js@2.49.1' {
  export function createClient(
    supabaseUrl: string,
    supabaseKey: string,
    options?: Record<string, unknown>,
  ): import('@supabase/supabase-js').SupabaseClient;
}
