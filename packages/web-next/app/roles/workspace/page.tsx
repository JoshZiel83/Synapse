import { redirect } from 'next/navigation';

export default function WorkspaceRolesPage() {
  redirect('/dashboard/access?scope=workspace');
}
