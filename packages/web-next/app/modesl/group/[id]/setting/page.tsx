import { redirect } from 'next/navigation';

export default async function LegacyMisspelledModelGroupSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/settings/models?groupId=${id}`);
}
