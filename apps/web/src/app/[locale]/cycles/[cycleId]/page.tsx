'use client';

import { useParams } from 'next/navigation';
import CycleWizard from '../../../../components/cycles/CycleWizard';

export default function ResumeCyclePage() {
  const params = useParams();
  const cycleId = params.cycleId as string;

  return <CycleWizard existingCycleId={cycleId} />;
}
