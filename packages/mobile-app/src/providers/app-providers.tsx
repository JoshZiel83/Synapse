import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';

import { SessionProvider } from '@/providers/session-provider';
import { WorkspaceProvider } from '@/providers/workspace-provider';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
