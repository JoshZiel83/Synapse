import { redirect } from 'next/navigation';

export default function DashboardSettingsRolesRedirectPage() {
  redirect('/roles/workspace');
}
