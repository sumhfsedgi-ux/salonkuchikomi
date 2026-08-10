import { randomInt } from "crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SLUG_LENGTH = 10;

// Salon names are Japanese, so they can't be turned into a readable
// English slug. A random string sidesteps that entirely -- satisfies the
// slug column's format/length check by construction and, at this length,
// makes a collision astronomically unlikely (still handled by retrying on
// the DB's unique-constraint error, see createSalonAction).
export function generateRandomSlug(): string {
  let slug = "";
  for (let i = 0; i < SLUG_LENGTH; i++) {
    slug += ALPHABET[randomInt(ALPHABET.length)];
  }
  return slug;
}
