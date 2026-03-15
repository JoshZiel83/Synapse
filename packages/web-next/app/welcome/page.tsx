import { redirect } from 'next/navigation';
import { buildLoginRedirect } from '@/lib/auth';
import { getServerAuthState } from '@/lib/server-auth';
import { AuthStoreProvider } from '@/stores/auth-store';
import WelcomeClient from './welcome-client';

export default async function WelcomePage() {
  const auth = await getServerAuthState();

  if (auth.status === 'unauthenticated') {
    redirect(buildLoginRedirect('/welcome'));
  }

  if (!auth.user) {
    throw new Error('Unable to validate the current session for onboarding.');
  }

  return (
    <AuthStoreProvider initialUser={auth.user}>
      <WelcomeClient />
    </AuthStoreProvider>
  );
}
