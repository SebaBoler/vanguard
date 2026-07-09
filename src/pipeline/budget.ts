/** Round to 6 decimal places to prevent IEEE 754 drift in USD cap comparisons and logs. */
export const roundUsd = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
