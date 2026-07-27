import { StatePage } from '@/components/layout/state-page';
import { Skeleton } from '@/components/ui/skeleton';

/** État transverse « chargement », affiché pendant une navigation (docs/screens.md). */
export default function Loading() {
  return (
    <StatePage>
      <Skeleton lines={4} withBlock />
    </StatePage>
  );
}
