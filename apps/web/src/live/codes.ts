/** Setup codes are 3 groups of 4. Backup codes are 2 groups of 5. */
export function looksLikeSetupCode(value: string): boolean {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').length === 12;
}
