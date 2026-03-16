import { redirect } from 'next/navigation';

export default function PlatformRolesPage() {
  redirect('/dashboard/access?scope=platform');
}
