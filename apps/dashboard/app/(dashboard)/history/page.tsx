import { HistoryPage } from '@/features/history/components/history-page';

type PageProps = {
  searchParams: Promise<{
    q?: string | string[];
    status?: string | string[];
    page?: string | string[];
    take?: string | string[];
  }>;
};

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;

  const search = typeof params.q === 'string' ? params.q.trim() : '';
  const status = typeof params.status === 'string' ? params.status : '';

  const page =
    typeof params.page === 'string' &&
    /^\d+$/.test(params.page) &&
    Number(params.page) >= 1 &&
    Number(params.page) <= 100000
      ? Number(params.page)
      : 1;
  const take =
    typeof params.take === 'string' &&
    /^\d+$/.test(params.take) &&
    Number(params.take) >= 1 &&
    Number(params.take) <= 50
      ? Number(params.take)
      : 10;
  return <HistoryPage search={search} status={status} page={page} take={take} />;
}
