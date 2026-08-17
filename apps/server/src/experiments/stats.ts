/**
 * Frequentist analysis for two-variant experiments.
 *
 * Deliberately small: a two-proportion z-test with a Wald confidence interval on
 * the difference. That is the right tool for the binary metrics this app tracks
 * ("did this user complete a translation?") and it is exact enough to keep the
 * ship/no-ship decision honest without pulling in a stats library.
 */

export interface VariantStats {
  variant: string;
  /** Users assigned to the variant. */
  exposures: number;
  /** Users who fired the metric at least once. */
  conversions: number;
  conversionRate: number;
}

export interface ComparisonResult {
  control: VariantStats;
  treatment: VariantStats;
  /** treatment − control, in absolute percentage points. */
  absoluteUplift: number;
  /** (treatment − control) / control. */
  relativeUplift: number;
  zScore: number;
  pValue: number;
  significant: boolean;
  confidenceLevel: number;
  /** 95% CI on the absolute difference. */
  confidenceInterval: [number, number];
  /** Human-readable ship recommendation. */
  verdict: 'treatment_wins' | 'control_wins' | 'inconclusive' | 'insufficient_data';
  /** Exposures per variant needed to detect the observed effect at 80% power. */
  requiredSampleSize: number;
}

export function rate(conversions: number, exposures: number): number {
  return exposures === 0 ? 0 : conversions / exposures;
}

/** Abramowitz & Stegun 7.1.26 — max error 1.5e-7, plenty for a p-value. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Two-tailed p-value for a z statistic. */
export function twoTailedPValue(z: number): number {
  return 2 * (1 - normalCdf(Math.abs(z)));
}

export function compareVariants(
  control: { variant: string; exposures: number; conversions: number },
  treatment: { variant: string; exposures: number; conversions: number },
  options: { alpha?: number; minSamplePerVariant?: number } = {},
): ComparisonResult {
  const alpha = options.alpha ?? 0.05;
  const minSample = options.minSamplePerVariant ?? 30;

  const p1 = rate(control.conversions, control.exposures);
  const p2 = rate(treatment.conversions, treatment.exposures);

  const controlStats: VariantStats = { ...control, conversionRate: p1 };
  const treatmentStats: VariantStats = { ...treatment, conversionRate: p2 };

  const absoluteUplift = p2 - p1;
  const relativeUplift = p1 === 0 ? (p2 === 0 ? 0 : Infinity) : absoluteUplift / p1;

  const n1 = control.exposures;
  const n2 = treatment.exposures;

  // Pooled proportion under H0 (the variants share one true rate).
  const pooled = n1 + n2 === 0 ? 0 : (control.conversions + treatment.conversions) / (n1 + n2);
  const standardError =
    n1 === 0 || n2 === 0 ? 0 : Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));

  const zScore = standardError === 0 ? 0 : absoluteUplift / standardError;
  const pValue = standardError === 0 ? 1 : twoTailedPValue(zScore);

  // The CI uses unpooled variance — under H1 the rates are not assumed equal.
  const seDiff =
    n1 === 0 || n2 === 0 ? 0 : Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  const margin = 1.959963985 * seDiff;

  const enoughData = n1 >= minSample && n2 >= minSample;
  const significant = enoughData && pValue < alpha;

  const verdict: ComparisonResult['verdict'] = !enoughData
    ? 'insufficient_data'
    : !significant
      ? 'inconclusive'
      : absoluteUplift > 0
        ? 'treatment_wins'
        : 'control_wins';

  return {
    control: controlStats,
    treatment: treatmentStats,
    absoluteUplift,
    relativeUplift,
    zScore,
    pValue,
    significant,
    confidenceLevel: 1 - alpha,
    confidenceInterval: [absoluteUplift - margin, absoluteUplift + margin],
    verdict,
    requiredSampleSize: requiredSampleSize(p1, Math.abs(absoluteUplift) || 0.05),
  };
}

/**
 * Per-variant sample size for a two-proportion test at α=0.05, power=0.8.
 *   n = (z_{α/2} + z_β)² · [p1(1−p1) + p2(1−p2)] / (p2 − p1)²
 */
export function requiredSampleSize(baseline: number, minimumDetectableEffect: number): number {
  if (minimumDetectableEffect <= 0) return Infinity;
  const zAlpha = 1.959963985; // two-tailed α = 0.05
  const zBeta = 0.841621234; // power = 0.80
  const p1 = clamp01(baseline);
  const p2 = clamp01(baseline + minimumDetectableEffect);
  const variance = p1 * (1 - p1) + p2 * (1 - p2);
  return Math.ceil(((zAlpha + zBeta) ** 2 * variance) / minimumDetectableEffect ** 2);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
