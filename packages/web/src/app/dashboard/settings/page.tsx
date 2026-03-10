'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Cpu, Users, Link2 } from 'lucide-react';
import ModelGroupList from './model-group-list';
import ActorAssignment from './actor-assignment';
import InviteManagement from './invite-management';

export default function SettingsPage() {
  const [tab, setTab] = useState('model-groups');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage model groups, AI configurations, actor assignments, and invites
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10">
          <TabsTrigger value="model-groups" className="data-[state=active]:bg-indigo-50 data-[state=active]:text-indigo-600 dark:data-[state=active]:bg-indigo-500/20 dark:data-[state=active]:text-indigo-400 gap-2">
            <Cpu className="w-4 h-4" />
            Model Groups
          </TabsTrigger>
          <TabsTrigger value="actor-assignment" className="data-[state=active]:bg-indigo-50 data-[state=active]:text-indigo-600 dark:data-[state=active]:bg-indigo-500/20 dark:data-[state=active]:text-indigo-400 gap-2">
            <Users className="w-4 h-4" />
            Actor Assignment
          </TabsTrigger>
          <TabsTrigger value="invites" className="data-[state=active]:bg-indigo-50 data-[state=active]:text-indigo-600 dark:data-[state=active]:bg-indigo-500/20 dark:data-[state=active]:text-indigo-400 gap-2">
            <Link2 className="w-4 h-4" />
            Invites
          </TabsTrigger>
        </TabsList>

        <TabsContent value="model-groups" className="mt-6">
          <ModelGroupList />
        </TabsContent>

        <TabsContent value="actor-assignment" className="mt-6">
          <ActorAssignment />
        </TabsContent>

        <TabsContent value="invites" className="mt-6">
          <InviteManagement />
        </TabsContent>
      </Tabs>
    </div>
  );
}
