import { redirect } from 'next/navigation';

export default function LegacyWorkspaceUserModelsPage() {
  redirect('/settings/models');
}
