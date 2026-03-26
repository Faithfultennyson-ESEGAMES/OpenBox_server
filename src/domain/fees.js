export function calculateFee({ grossStakeTotal, platformFeeType, platformFeeValue }) {
  if (platformFeeType === 'fixed') {
    return Math.max(0, Math.min(grossStakeTotal, platformFeeValue));
  }
  return Math.max(0, Math.min(grossStakeTotal, (grossStakeTotal * platformFeeValue) / 100));
}
