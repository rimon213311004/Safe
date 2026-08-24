import type { SubjectIdentifierInput } from '@safecheck/shared';
import type { IdentifierType } from '@safecheck/shared';
import { hashIdentifier } from '../lib/crypto.js';
import { SubjectProfile, type SubjectProfileDoc } from '../models/index.js';
import { User } from '../models/index.js';

/**
 * Subject resolution.
 *
 * Turning a reporter's plaintext identifiers into a SubjectProfile is the one
 * place plaintext identifiers exist in the request path, and they must not
 * escape it: nothing here logs them, stores them, or returns them.
 */

export interface HashedIdentifier {
  type: IdentifierType;
  hash: string;
}

/** Hash every identifier the reporter supplied. Plaintext stops here. */
export function hashSubjectIdentifiers(input: SubjectIdentifierInput): HashedIdentifier[] {
  const out: HashedIdentifier[] = [];
  if (input.email) out.push({ type: 'email', hash: hashIdentifier('email', input.email) });
  if (input.phone) out.push({ type: 'phone', hash: hashIdentifier('phone', input.phone) });
  return out;
}

/**
 * Find or create the profile for a set of identifiers.
 *
 * If any supplied hash already belongs to a profile, that's the same person and
 * we reuse it, merging in any identifier we hadn't seen before. This is how
 * multiple independent reports about one person accumulate against a single
 * subject without anyone ever handling their plaintext details.
 */
export async function resolveSubject(
  input: SubjectIdentifierInput,
): Promise<SubjectProfileDoc> {
  const hashed = hashSubjectIdentifiers(input);
  if (hashed.length === 0) {
    throw new Error('resolveSubject called with no identifiers — validation should prevent this');
  }
  const hashes = hashed.map((h) => h.hash);

  const existing = await SubjectProfile.findOne({ 'identifiers.hash': { $in: hashes } });

  if (existing) {
    const known = new Set(existing.identifiers.map((i) => i.hash));
    const additions = hashed.filter((h) => !known.has(h.hash));
    if (additions.length > 0) {
      existing.identifiers.push(...additions);
    }
    // Keep the moderator-facing label fresh if we didn't have one.
    if (input.knownAs && !existing.knownAs) existing.knownAs = input.knownAs;
    if (additions.length > 0 || (input.knownAs && !existing.knownAs)) await existing.save();
    return existing;
  }

  // Link to a platform account if one owns this email, so the subject can be
  // notified in-app rather than only by email.
  let linkedUserId: SubjectProfileDoc['linkedUserId'] = null;
  if (input.email) {
    const account = await User.findOne({ email: input.email }).select('_id').lean();
    if (account) linkedUserId = account._id;
  }

  return SubjectProfile.create({
    identifiers: hashed,
    knownAs: input.knownAs ?? '',
    linkedUserId,
  });
}

/**
 * Look up a subject for a search query. Returns null when the identifier is
 * unknown — the caller must respond identically for "unknown" and "known but
 * nothing disclosable", so that response shape can't reveal hidden reports.
 */
export async function findSubjectByIdentifier(params: {
  type: IdentifierType;
  value: string;
}): Promise<SubjectProfileDoc | null> {
  const hash = hashIdentifier(params.type, params.value);
  return SubjectProfile.findOne({ 'identifiers.hash': hash });
}

/**
 * A short, non-identifying label for moderator UI and the reporter's own list.
 * Never derived from the identifier itself, so it cannot leak one.
 */
export function subjectLabel(subject: SubjectProfileDoc): string {
  if (subject.knownAs) return subject.knownAs;
  const kinds = subject.identifiers.map((i) => i.type);
  const unique = [...new Set(kinds)].join(' + ');
  return unique ? `Unnamed subject (${unique} on file)` : 'Unnamed subject';
}

/** Record that the subject has been told about a decision concerning them. */
export async function markSubjectNotified(
  subjectId: string,
  channel: string,
): Promise<void> {
  await SubjectProfile.updateOne(
    { _id: subjectId, notifiedAt: null },
    { $set: { notifiedAt: new Date(), notificationChannel: channel } },
  );
}
