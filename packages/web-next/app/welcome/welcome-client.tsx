'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { useAuthStore } from '@/stores/auth-store';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Building2, UserPlus } from 'lucide-react';

export default function WelcomeClient() {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>('choose');
  const [wsName, setWsName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!user) {
    return null;
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!wsName.trim()) {
      setError('Please enter a workspace name');
      return;
    }

    setSubmitting(true);
    try {
      const ws = await api.createWorkspace(wsName.trim());
      if (ws?.id) {
        localStorage.setItem('workspaceId', ws.id);
        router.push('/dashboard');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create workspace');
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!inviteCode.trim()) {
      setError('Please enter an invite code');
      return;
    }

    setSubmitting(true);
    try {
      const result = await api.redeemInvite(inviteCode.trim());
      if (result?.workspaceId) {
        localStorage.setItem('workspaceId', result.workspaceId);
        router.push('/dashboard');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to join workspace');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      <div className="flex flex-1 flex-col justify-center px-4 py-12 sm:px-6 lg:flex-none lg:px-20 xl:px-24">
        <div className="mx-auto w-full max-w-md">
          <div className="flex items-center gap-3 mb-8">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600 p-1.5">
              <Image src="/synapse.svg" alt="Synapse" width={28} height={28} className="invert" />
            </div>
            <span className="text-xl font-semibold text-gray-900 dark:text-white">Synapse</span>
          </div>

          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Welcome, {user.name}!
          </h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Get started by creating a new workspace or joining an existing one.
          </p>

          {error ? (
            <div className="mt-4 rounded-md bg-red-50 dark:bg-red-500/10 p-3 border border-red-200 dark:border-red-500/20">
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            </div>
          ) : null}

          {mode === 'choose' ? (
            <div className="mt-8 grid gap-4">
              <Card
                className="cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors"
                onClick={() => setMode('create')}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-500/10">
                      <Building2 className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Create Workspace</CardTitle>
                      <CardDescription>Start fresh with a new workspace</CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>

              <Card
                className="cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors"
                onClick={() => setMode('join')}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50 dark:bg-emerald-500/10">
                      <UserPlus className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Join Workspace</CardTitle>
                      <CardDescription>Use an invite code to join a team</CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </div>
          ) : null}

          {mode === 'create' ? (
            <form onSubmit={handleCreate} className="mt-8 space-y-4">
              <div>
                <Label htmlFor="wsName">Workspace name</Label>
                <Input
                  id="wsName"
                  value={wsName}
                  onChange={(e) => setWsName(e.target.value)}
                  placeholder="My Team"
                  className="mt-1.5"
                  autoFocus
                />
              </div>
              <div className="flex gap-3">
                <Button type="button" variant="outline" onClick={() => { setMode('choose'); setError(''); }}>
                  Back
                </Button>
                <Button type="submit" disabled={submitting} className="flex-1">
                  {submitting ? 'Creating...' : 'Create Workspace'}
                </Button>
              </div>
            </form>
          ) : null}

          {mode === 'join' ? (
            <form onSubmit={handleJoin} className="mt-8 space-y-4">
              <div>
                <Label htmlFor="inviteCode">Invite code</Label>
                <Input
                  id="inviteCode"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="e.g. Ab3xK9mZ"
                  className="mt-1.5"
                  autoFocus
                />
              </div>
              <div className="flex gap-3">
                <Button type="button" variant="outline" onClick={() => { setMode('choose'); setError(''); }}>
                  Back
                </Button>
                <Button type="submit" disabled={submitting} className="flex-1">
                  {submitting ? 'Joining...' : 'Join Workspace'}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      </div>

      <div className="relative hidden w-0 flex-1 lg:block">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-600 via-indigo-700 to-purple-800">
          <svg className="absolute inset-0 h-full w-full opacity-[0.15]" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="welcome-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#welcome-grid)" />
          </svg>
          <div className="absolute top-1/4 left-1/4 h-64 w-64 rounded-full bg-white/10 blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 h-80 w-80 rounded-full bg-purple-400/10 blur-3xl" />
          <div className="relative flex h-full flex-col items-center justify-center px-12 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-white/10 backdrop-blur-sm p-3 mb-8 ring-1 ring-white/20">
              <Image src="/synapse.svg" alt="Synapse" width={52} height={52} className="invert" />
            </div>
            <h2 className="text-3xl font-bold text-white">
              Set Up Your
              <br />
              Digital Workforce.
            </h2>
            <p className="mt-4 max-w-md text-lg text-indigo-100/80">
              Create or join a workspace to start orchestrating AI-powered digital employees.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
