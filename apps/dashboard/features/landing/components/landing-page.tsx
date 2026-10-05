import {
  ArrowRight,
  Check,
  History,
  MessageSquare,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';

export function LandingPage() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <ShieldCheck aria-hidden="true" className="size-5 text-emerald-700" />
          AI Toxic Moderator
        </Link>
        <Button asChild variant="outline" size="sm">
          <Link href="/login">Sign in</Link>
        </Button>
      </header>
      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-16 sm:py-24 lg:grid-cols-[1.1fr_1fr]">
          <div className="space-y-7">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-400">
              Made for YouTube streamers
            </p>
            <h1 className="max-w-xl text-5xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">
              Focus on your stream.
              <br />
              <span className="text-emerald-700 dark:text-emerald-400">Keep chat in check.</span>
            </h1>
            <p className="max-w-lg text-lg leading-8 text-muted-foreground">
              Let AI check your live chat, block unwanted words, and take the actions you choose.
              Review what happened when your stream is over.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <Button asChild size="lg">
                <Link href="/login">
                  Set up your moderation
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
              <a
                href="#how-it-works"
                className="text-sm font-medium underline-offset-4 hover:underline"
              >
                See how it works
              </a>
            </div>
            <p className="max-w-md text-xs leading-5 text-muted-foreground">
              You stay in control of blocked words and AI action limits. AI can make mistakes, so
              start with cautious settings.
            </p>
          </div>
          <div className="rounded-3xl bg-emerald-50 p-5 sm:p-8 dark:bg-emerald-950/30">
            <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <MessageSquare aria-hidden="true" className="size-4" />
                  Your live chat
                </div>
                <span className="text-xs text-muted-foreground">Example preview</span>
              </div>
              <div className="divide-y px-5">
                <div className="space-y-2 py-5">
                  <p className="text-xs font-medium text-muted-foreground">Viewer</p>
                  <p className="text-sm">Great stream, thanks for sharing!</p>
                  <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                    <Check aria-hidden="true" className="size-3.5" />
                    No action needed
                  </p>
                </div>
                <div className="space-y-2 py-5">
                  <p className="text-xs font-medium text-muted-foreground">Viewer</p>
                  <p className="text-sm text-muted-foreground">
                    A message containing a blocked phrase
                  </p>
                  <p className="text-xs font-medium">Blocked word matched · Message deleted</p>
                </div>
                <div className="space-y-2 py-5">
                  <p className="text-xs font-medium text-muted-foreground">Viewer</p>
                  <p className="text-sm text-muted-foreground">
                    A message above your AI action limit
                  </p>
                  <p className="text-xs font-medium">AI checked · Timeout confirmed</p>
                </div>
              </div>
            </div>
            <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
              Illustrative results. Actual actions depend on your settings and YouTube confirmation.
            </p>
          </div>
        </section>
        <section id="how-it-works" aria-labelledby="how-heading" className="border-y bg-muted/30">
          <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
            <div className="mb-10 max-w-xl space-y-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Before, during, and after your stream
              </p>
              <h2 id="how-heading" className="text-3xl font-semibold tracking-tight">
                Your chat. Your rules.
              </h2>
              <p className="text-sm leading-6 text-muted-foreground">
                Set your preferences once, then start monitoring when you go live.
              </p>
            </div>
            <div className="grid gap-8 md:grid-cols-3">
              {[
                {
                  icon: SlidersHorizontal,
                  title: 'Choose what gets blocked',
                  text: 'Add unwanted words or phrases. Choose deletion only, or add a timeout or ban for the sender.',
                },
                {
                  icon: ShieldCheck,
                  title: 'Let AI check your chat',
                  text: 'Choose the action limits for deleting messages, timing out viewers, or hiding them from chat. Follow results as they arrive.',
                },
                {
                  icon: History,
                  title: 'Catch up after your stream',
                  text: 'Review saved chat, moderation results, and stream summaries in History. See what was planned and what YouTube confirmed.',
                },
              ].map(({ icon: Icon, title, text }) => (
                <div key={title} className="space-y-4">
                  <Icon
                    aria-hidden="true"
                    className="size-6 text-emerald-700 dark:text-emerald-400"
                  />
                  <h3 className="text-lg font-semibold">{title}</h3>
                  <p className="text-sm leading-7 text-muted-foreground">{text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-16 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl space-y-3">
            <h2 className="text-2xl font-semibold tracking-tight">Ready for your next stream?</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Connect your Google account, review your moderation settings, and start monitoring
              from Live.
            </p>
          </div>
          <Button asChild size="lg">
            <Link href="/login">
              Open dashboard
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </section>
      </main>
      <footer className="border-t px-6 py-6 text-center text-xs leading-5 text-muted-foreground">
        AI Toxic Moderator · An independent project for YouTube streamers.
      </footer>
    </div>
  );
}
