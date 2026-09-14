import { Button } from '@/components/ui/button';

type LiveHeaderProps = {
  refreshing: boolean;
  onRefresh: () => void;
};

export function LiveHeader({ refreshing, onRefresh }: LiveHeaderProps) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Live</h1>
        <p className="text-sm text-muted-foreground">
          Active YouTube broadcasts from your connected account.
        </p>
      </div>

      <Button variant="outline" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? 'Refreshing…' : 'Refresh broadcasts'}
      </Button>
    </header>
  );
}
