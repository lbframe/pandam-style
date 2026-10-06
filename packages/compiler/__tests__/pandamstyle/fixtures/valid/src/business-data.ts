/**
 * Ordinary application data that happens to use authority-sounding words.
 *
 * A compiler that enforces a profile must not censor business vocabulary.
 * `role` and `trusted` in DATA are fields, not attempts to gain authority:
 * authority comes from the build configuration, and the only way to try to
 * influence it from here is to pass such a field to a recognized PandamStyle
 * export, or to use the reserved `__pms*` namespace.
 *
 * This file must compile. If it ever stops compiling, the compiler has become a
 * vocabulary filter.
 */

export interface Account {
  id: string;
  role: 'admin' | 'member' | 'guest';
  trusted: boolean;
  displayName: string;
}

export const currentUser: Account = {
  id: 'user-001',
  role: 'admin',
  trusted: true,
  displayName: 'Example User',
};

export const permissions: Array<{ role: string; scope: string }> = [
  { role: 'owner', scope: 'billing' },
  { role: 'member', scope: 'projects' },
];

/** A payload shape, not a policy declaration. */
export function sessionPayload(account: Account) {
  return {
    role: account.role,
    trusted: account.trusted,
    issuedTo: account.displayName,
  };
}
