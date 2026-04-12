import { loadFamilyAccess, type FamilyAccessState } from '@/lib/familyAccess';
import { supabase } from '@/lib/supabase';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { RealtimeChannel } from '@supabase/supabase-js';

type FamilyAccessContextValue = {
  access: FamilyAccessState | null | undefined;
  refresh: () => Promise<void>;
};

const FamilyAccessContext = createContext<FamilyAccessContextValue>({
  access: undefined,
  refresh: async () => {},
});

export function FamilyAccessProvider({ children }: { children: React.ReactNode }) {
  const [access, setAccess] = useState<FamilyAccessState | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    const a = await loadFamilyAccess();
    setAccess(a);
  }, []);

  useEffect(() => {
    let userChannel: RealtimeChannel | null = null;

    const teardownChannel = () => {
      if (userChannel) {
        void supabase.removeChannel(userChannel);
        userChannel = null;
      }
    };

    const bindUserRowUpdates = (userId: string) => {
      teardownChannel();
      userChannel = supabase
        .channel(`family-access:users:${userId}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'users',
            filter: `id=eq.${userId}`,
          },
          () => void refresh()
        )
        .subscribe((status, err) => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn('[FamilyAccess] users realtime', status, err?.message ?? err);
          }
        });
    };

    void refresh();

    const { data: { subscription: authSubscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        teardownChannel();
        if (!session?.user) {
          setAccess(null);
          return;
        }
        void refresh();
        bindUserRowUpdates(session.user.id);
      }
    );

    const onAppState = (state: AppStateStatus) => {
      if (state === 'active') void refresh();
    };
    const appSub = AppState.addEventListener('change', onAppState);

    return () => {
      authSubscription.unsubscribe();
      appSub.remove();
      teardownChannel();
    };
  }, [refresh]);

  const value = useMemo(() => ({ access, refresh }), [access, refresh]);

  return (
    <FamilyAccessContext.Provider value={value}>{children}</FamilyAccessContext.Provider>
  );
}

export function useFamilyAccess() {
  return useContext(FamilyAccessContext);
}
