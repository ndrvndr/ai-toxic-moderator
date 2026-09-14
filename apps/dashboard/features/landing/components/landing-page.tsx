import Link from 'next/link';

import { Button } from '@/components/ui/button';

export function LandingPage() {
  return (
    <main className="flex min-h-svh items-center justify-center px-6 py-16">
      <div className="max-w-2xl space-y-6 text-center">
        <p className="text-sm font-semibold tracking-widest text-muted-foreground">
          AI TOXIC MODERATOR
        </p>
        <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
          A clearer view of your YouTube live chat.
        </h1>
        <p className="text-lg leading-8 text-muted-foreground">
          Connect your Google account and view your active broadcasts. Automatic chat monitoring is
          coming next.
        </p>
        <Button asChild>
          <Link href="/login">Open dashboard</Link>
        </Button>
      </div>
    </main>
  );
}
