import { HistoryDetailPage } from '@/features/history/components/history-detail-page';

type PageProps = {
  params: Promise<{ sessionId: string }>;
};

export default async function Page({ params }: PageProps) {
  const { sessionId } = await params;

  return <HistoryDetailPage sessionId={sessionId} />;
}
