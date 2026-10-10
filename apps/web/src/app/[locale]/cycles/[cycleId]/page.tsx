'use client';

import { useParams } from 'next/navigation';
import CycleWizard from '../../../../components/cycles/CycleWizard';
import { WizardGate } from '../../../../components/cycles/WizardGate';

export default function ResumeCyclePage() {
  const params = useParams();
  const cycleId = params.cycleId as string;

  return (
    <WizardGate cycleId={cycleId}>
      <CycleWizard existingCycleId={cycleId} />
    </WizardGate>
  );
}
