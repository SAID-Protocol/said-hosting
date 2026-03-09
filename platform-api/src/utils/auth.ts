/**
 * Auth utility functions for secure credential handling
 */

import crypto from 'crypto';

/**
 * Hash a gateway token using SHA-256
 * @param token The plaintext gateway token
 * @returns Hexadecimal hash string
 */
export function hashGatewayToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a new random gateway token
 * @returns 48-character hexadecimal token
 */
export function generateGatewayToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Verify a plaintext token against a stored hash
 * @param plaintext The token to verify
 * @param storedHash The hash from the database
 * @returns True if the token matches the hash
 */
export function verifyGatewayToken(plaintext: string, storedHash: string): boolean {
  return hashGatewayToken(plaintext) === storedHash;
}
