import { HistoryPage } from '@/features/history/components/history-page';

type PageProps = {
  searchParams: Promise<{
    q?: string | string[];
    status?: string | string[];
  }>;
};

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;

  const search = typeof params.q === 'string' ? params.q.trim() : '';
  const status = typeof params.status === 'string' ? params.status : '';

  return <HistoryPage search={search} status={status} />;
}
