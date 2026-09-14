'use client';

import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useLogout } from '@/features/auth/hooks/use-logout';
import { useSession } from '@/features/auth/hooks/use-session';
import { getErrorMessage } from '@/lib/api-client';

export function DashboardHeader() {
  const session = useSession();
  const logout = useLogout();

  return (
    <header className="border-b px-4 py-3">
      <div className="flex items-center gap-3">
        <SidebarTrigger aria-label="Toggle navigation" />

        <p className="min-w-0 flex-1 truncate text-sm">{session.data?.account.display_name}</p>

        <Button variant="outline" disabled={logout.isPending} onClick={() => logout.mutate()}>
          {logout.isPending ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>

      {logout.isError && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          Sign-out failed. {getErrorMessage(logout.error)}
        </p>
      )}
    </header>
  );
}
