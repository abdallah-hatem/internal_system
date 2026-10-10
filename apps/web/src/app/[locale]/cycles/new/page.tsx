'use client';

import CycleWizard from '../../../../components/cycles/CycleWizard';
import { WizardGate } from '../../../../components/cycles/WizardGate';

export default function NewCyclePage() {
  return (
    <WizardGate>
      <CycleWizard />
    </WizardGate>
  );
}
