'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function AuthorizationsRedirectPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const instanceId = searchParams.get('instanceId');
    if (instanceId) {
      router.replace(`/dashboard/plugins/installations/${instanceId}`);
      return;
    }

    router.replace('/dashboard/plugins');
  }, [router, searchParams]);

  return <div className="py-16 text-center text-sm text-muted-foreground">Redirecting...</div>;
}
