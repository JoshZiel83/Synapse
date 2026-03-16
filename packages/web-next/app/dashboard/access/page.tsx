'use client';

import { useSearchParams } from 'next/navigation';
import AccessManagement from '@/app/dashboard/settings/access-management';

export default function DashboardAccessPage() {
  const searchParams = useSearchParams();
  const scope = searchParams.get('scope');
  const mode = scope === 'workspace' || scope === 'platform' ? scope : 'all';

  return <AccessManagement mode={mode} showIntro />;
}
