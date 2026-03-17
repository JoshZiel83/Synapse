'use client';

import { useParams } from 'next/navigation';

import { MarketplaceSkillPreviewPage } from '../../skills-client';

export default function MarketplaceSkillRoutePage() {
  const params = useParams<{ skillId: string }>();

  return <MarketplaceSkillPreviewPage skillId={params.skillId} />;
}
