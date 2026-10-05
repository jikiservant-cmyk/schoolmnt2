import { randomInt } from 'crypto';

const PIN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I ambiguity
export const PIN_BCRYPT_ROUNDS = 10;

/**
 * Generate a teacher attendance PIN like "T7K9M2" using a CSPRNG.
 *
 * Previously PINs came from Math.random() (predictable V8 xorshift128+ state)
 * and "uniqueness" was enforced by loading EVERY staff pin_hash across ALL
 * tenants and running synchronous bcrypt compares on each one — an O(N)
 * event-loop-blocking operation (DoS) that also wasn't needed, because PIN
 * verification is always bound to an explicitly selected teacher.
 */
export function generateTeacherPin(): string {
  let pin = 'T';
  for (let i = 0; i < 5; i++) {
    pin += PIN_ALPHABET[randomInt(PIN_ALPHABET.length)];
  }
  return pin;
}
