export interface StepProps {
  stepNumber: number;
  stepCount: number;
  onNext: () => void;
  onBack?: () => void;
}
